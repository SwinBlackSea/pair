import test from "node:test";
import assert from "node:assert/strict";
import {
  EastMoneyHKProvider,
  EastMoneyProvider,
  EastMoneySymbolSearchProvider,
  RoutedMarketProvider,
  TencentQuoteProvider,
  normalizeSymbolSearchResult,
  parseSymbolSearchResponse,
  createMarketProvider,
  inferAShareExchange,
  isHongKongSymbol,
  resolveAShareExchange,
  toEastMoneySecId,
} from "../src/market.js";

function encodedResponse(text) {
  return new Response(new TextEncoder().encode(text), { status: 200 });
}

test("腾讯行情代码支持港股常见格式", () => {
  const provider = new TencentQuoteProvider();
  assert.equal(provider.toQuoteCode("00700"), "hk00700");
  assert.equal(provider.toQuoteCode("hk00700"), "hk00700");
  assert.equal(provider.toQuoteCode("00700.HK"), "hk00700");
});

test("腾讯行情代码支持沪深 A 股格式", () => {
  const provider = new TencentQuoteProvider();
  assert.equal(provider.toQuoteCode("600519"), "sh600519");
  assert.equal(provider.toQuoteCode("600519.SH"), "sh600519");
  assert.equal(provider.toQuoteCode("SZ000858"), "sz000858");
  assert.equal(provider.toQuoteCode("513310"), "sh513310");
  assert.throws(() => provider.toQuoteCode("513310.sz"), /属于 SH.*输入的 SZ 不一致/);
});

test("A 股代码可识别股票、ETF 与北交所交易所", () => {
  assert.equal(inferAShareExchange("600519"), "SH");
  assert.equal(inferAShareExchange("513310"), "SH");
  assert.equal(inferAShareExchange("159915"), "SZ");
  assert.equal(inferAShareExchange("830799"), "BJ");
  assert.equal(resolveAShareExchange("513310"), "SH");
  assert.deepEqual(toEastMoneySecId("513310"), { secid: "1.513310", symbol: "513310.SH" });
  assert.throws(() => toEastMoneySecId("513310.sz"), /属于 SH.*输入的 SZ 不一致/);
});

test("腾讯行情响应映射为统一报价结构", async () => {
  const provider = new TencentQuoteProvider({
    fetchImpl: async () => encodedResponse('v_hk00700="1~Tencent~00700~440.000~443.000~ignored";'),
  });
  const quote = await provider.quote("00700");
  assert.equal(quote.symbol, "hk00700");
  assert.equal(quote.name, "Tencent");
  assert.equal(quote.price, 440);
  assert.equal(quote.previousClose, 443);
  assert.equal(quote.provider, "tencent");
  assert.match(quote.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});
test("东方财富港股 push2delay 解析精度、行情时间并带 Referer", async () => {
  const unixSeconds = 1787711123;
  const provider = new EastMoneyHKProvider({
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).hostname, "push2delay.eastmoney.com");
      assert.equal(new URL(url).searchParams.get("secid"), "116.00700");
      assert.equal(new URL(url).searchParams.get("fields"), "f43,f58,f59,f60,f86");
      assert.equal(options.headers.Referer, "https://quote.eastmoney.com/");
      return Response.json({ data: { f43: 448800, f58: "腾讯控股", f59: 3, f60: 442000, f86: unixSeconds } });
    },
  });

  const quote = await provider.quote("00700.HK");
  assert.equal(quote.symbol, "hk00700");
  assert.equal(quote.name, "腾讯控股");
  assert.equal(quote.price, 448.8);
  assert.equal(quote.previousClose, 442);
  assert.equal(quote.timestamp, new Date(unixSeconds * 1000).toISOString());
  assert.equal(quote.provider, "eastmoney-hk");
});


test("东方财富按证券价格精度解析 ETF 行情", async () => {
  const provider = new EastMoneyProvider({
    fetchImpl: async () => Response.json({ data: { f43: 4718, f57: "513310", f58: "中韩半导体ETF华泰柏瑞", f59: 3, f60: 4642 } }),
  });

  const quote = await provider.quote("513310");
  assert.equal(quote.price, 4.718);
  assert.equal(quote.previousClose, 4.642);
});

test("东方财富返回零价时自动改用腾讯行情", async () => {
  const provider = new RoutedMarketProvider({
    aShareProvider: new EastMoneyProvider({
      fetchImpl: async () => Response.json({ data: { f43: 0, f57: "513310", f58: "中韩半导体ETF", f59: 3, f60: 4754 } }),
    }),
    aShareFallbackProvider: { quote: async (symbol) => ({ symbol, name: "腾讯备用", price: 4.754, provider: "tencent" }) },
  });
  const quote = await provider.quote("513310");
  assert.equal(quote.provider, "tencent");
  assert.equal(quote.price, 4.754);
});

test("东方财富临时失败时使用腾讯获取同一 A 股代码", async () => {
  const calls = [];
  const provider = new RoutedMarketProvider({
    aShareProvider: { quote: async () => { calls.push("eastmoney"); throw new Error("行情源返回 HTTP 502"); } },
    aShareFallbackProvider: { quote: async (symbol) => { calls.push("tencent:" + symbol); return { symbol, provider: "tencent" }; } },
  });

  const quote = await provider.quote("513310");
  assert.equal(quote.provider, "tencent");
  assert.deepEqual(calls, ["eastmoney", "tencent:513310"]);
});

test("输入校验错误不会触发备用行情源", async () => {
  let fallbackCalled = false;
  const provider = new RoutedMarketProvider({
    aShareProvider: { quote: async () => { throw new Error("股票代码 513310 属于 SH，与输入的 SZ 不一致"); } },
    aShareFallbackProvider: { quote: async () => { fallbackCalled = true; } },
  });

  await assert.rejects(provider.quote("513310.SZ"), /不一致/);
  assert.equal(fallbackCalled, false);
});


test("中文搜索结果会转换为标准标的代码", () => {
  const payload = {
    QuotationCodeTable: {
      Data: [
        { Code: "600519", Name: "贵州茅台", MktNum: "1" },
        { Code: "00700", Name: "腾讯控股", MktNum: "128" },
      ],
    },
  };
  assert.deepEqual(parseSymbolSearchResponse(payload), [
    { symbol: "600519.SH", name: "贵州茅台", market: "沪市" },
    { symbol: "HK00700", name: "腾讯控股", market: "港股" },
  ]);
  assert.deepEqual(normalizeSymbolSearchResult({ Code: "000858", Name: "五粮液", MktNum: "0" }), {
    symbol: "000858.SZ", name: "五粮液", market: "深市",
  });
});

test("标的搜索支持 JSONP 并使用短缓存", async () => {
  let calls = 0;
  const provider = new EastMoneySymbolSearchProvider({
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(new URL(url).searchParams.get("input"), "茅台");
      return new Response('jQuery123({"QuotationCodeTable":{"Data":[{"Code":"600519","Name":"贵州茅台","MktNum":"1"}]}})', { status: 200 });
    },
  });
  assert.deepEqual(await provider.search("茅台"), [{ symbol: "600519.SH", name: "贵州茅台", market: "沪市" }]);
  assert.deepEqual(await provider.search("茅台"), [{ symbol: "600519.SH", name: "贵州茅台", market: "沪市" }]);
  assert.equal(calls, 1);
});

test("标的搜索临时失败时会自动重试", async () => {
  let calls = 0;
  const provider = new EastMoneySymbolSearchProvider({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary failure");
      return Response.json({ QuotationCodeTable: { Data: [{ Code: "600909", Name: "华安证券", MktNum: "1" }] } });
    },
  });

  assert.deepEqual(await provider.search("华安证券"), [
    { symbol: "600909.SH", name: "华安证券", market: "沪市" },
  ]);
  assert.equal(calls, 2);
});

test("默认工厂创建东方财富自动路由", () => {
  assert.equal(createMarketProvider().name, "eastmoney");
  assert.throws(() => createMarketProvider("mock"), /不支持的行情源/);
});

test("东方财富配置会把港股自动路由到东方财富准实时源", async () => {
  const calls = [];
  const provider = new RoutedMarketProvider({
    aShareProvider: { quote: async (symbol) => { calls.push(`eastmoney:${symbol}`); return { symbol }; } },
    hongKongProvider: { quote: async (symbol) => { calls.push("eastmoney-hk:" + symbol); return { symbol }; } },
  });

  assert.equal(isHongKongSymbol("HK00700"), true);
  assert.equal(isHongKongSymbol("00700.HK"), true);
  assert.equal(isHongKongSymbol("600519"), false);
  await provider.quote("HK00700");
  await provider.quote("600519");
  assert.deepEqual(calls, ["eastmoney-hk:HK00700", "eastmoney:600519"]);
  assert.equal(createMarketProvider("eastmoney").name, "eastmoney");
});
