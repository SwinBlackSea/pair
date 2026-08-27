import { normalizeSymbol } from "./engine.js";

const EASTMONEY_SUGGEST_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";

function parseJsonOrJsonp(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/^[^(]+\((.*)\)\s*;?$/s);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
}

function searchItemSymbol(item) {
  const code = String(item?.Code || item?.code || item?.SecurityCode || "").trim().toUpperCase();
  if (!code) return null;
  const quoteId = String(item?.QuoteID || item?.quoteId || "");
  const market = String(item?.MktNum || item?.Market || quoteId.split(".")[0] || "");
  if (/^\d{6}$/.test(code)) {
    const exchange = market === "1" ? "SH" : market === "0" ? "SZ" : market === "2" ? "BJ" : inferAShareExchange(code);
    return code + "." + exchange;
  }
  if (/^\d{5}$/.test(code)) return "HK" + code;
  return code;
}

export function normalizeSymbolSearchResult(item) {
  const symbol = searchItemSymbol(item);
  if (!symbol) return null;
  const name = String(item?.Name || item?.name || item?.SecurityName || "").trim();
  if (!name) return null;
  const market = symbol.endsWith(".SH") ? "沪市" : symbol.endsWith(".SZ") ? "深市" : symbol.endsWith(".BJ") ? "北交所" : symbol.startsWith("HK") ? "港股" : "其他";
  return { symbol, name, market };
}

export function parseSymbolSearchResponse(payload) {
  const items = payload?.QuotationCodeTable?.Data
    || payload?.QuotationCodeTable?.data
    || payload?.data
    || [];
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  return items.map(normalizeSymbolSearchResult).filter((item) => {
    if (!item || seen.has(item.symbol)) return false;
    seen.add(item.symbol);
    return true;
  });
}

export class EastMoneySymbolSearchProvider {
  constructor({ fetchImpl = fetch, ttlMs = 30_000, maxCacheSize = 100 } = {}) {
    this.name = "eastmoney-search";
    this.fetchImpl = fetchImpl;
    this.ttlMs = ttlMs;
    this.maxCacheSize = maxCacheSize;
    this.cache = new Map();
  }

  async search(queryInput) {
    const query = String(queryInput ?? "").trim();
    if (!query) return [];
    const cached = this.cache.get(query);
    if (cached && cached.expiresAt > Date.now()) return cached.items;

    const url = new URL("https://searchapi.eastmoney.com/api/suggest/get");
    url.searchParams.set("input", query.slice(0, 40));
    url.searchParams.set("type", "14");
    url.searchParams.set("count", "8");
    url.searchParams.set("token", EASTMONEY_SUGGEST_TOKEN);

    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          signal: AbortSignal.timeout(5_000),
          headers: { "Accept": "application/json,text/plain,*/*", "User-Agent": "SpreadSentinel/1.0" },
        });
        if (!response.ok) throw new Error("标的搜索源返回 HTTP " + response.status);

        const payload = parseJsonOrJsonp(await response.text());
        const items = parseSymbolSearchResponse(payload);
        this.cache.set(query, { expiresAt: Date.now() + this.ttlMs, items });
        while (this.cache.size > this.maxCacheSize) this.cache.delete(this.cache.keys().next().value);
        return items;
      } catch (error) {
        lastError = error;
      }
    }

    if (cached) return cached.items;
    throw new Error("连接标的搜索源失败：" + lastError.message);
  }
}

function fetchError(error) {
  if (error?.name === "TimeoutError") return "行情请求超时";
  return "连接行情源失败：" + error.message;
}

export function inferAShareExchange(digits) {
  if (/^[569]/.test(digits)) return "SH";
  if (/^[0123]/.test(digits)) return "SZ";
  if (/^[48]/.test(digits)) return "BJ";
  return "SZ";
}

export function resolveAShareExchange(digits, explicitExchange = null) {
  const inferredExchange = inferAShareExchange(digits);
  if (explicitExchange && explicitExchange !== inferredExchange) {
    throw new Error("股票代码 " + digits + " 属于 " + inferredExchange + "，与输入的 " + explicitExchange + " 不一致");
  }
  return explicitExchange || inferredExchange;
}

export function isHongKongSymbol(symbolInput) {
  const symbol = normalizeSymbol(symbolInput).replace(/[._-]/g, "");
  return /^HK\d{5}$/.test(symbol) || /^\d{5}HK$/.test(symbol) || /^\d{5}$/.test(symbol);
}

// 腾讯字段 31 使用北京时间 YYYYMMDDHHmmss。响应到达时间不能代表行情时间，
// 否则上游缓存的旧报价会被错误地标记为刚更新。
export function parseTencentQuoteTimestamp(value) {
  const match = String(value ?? "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const timestamp = new Date(Date.UTC(year, Number(month) - 1, day, Number(hour) - 8, minute, second));
  return Number.isNaN(timestamp.valueOf()) ? null : timestamp.toISOString();
}

export class TencentQuoteProvider {
  constructor({ fetchImpl = fetch, searchProvider = new EastMoneySymbolSearchProvider() } = {}) {
    this.name = "tencent";
    this.fetchImpl = fetchImpl;
    this.searchProvider = searchProvider;
  }

  search(query) {
    return this.searchProvider.search(query);
  }

  toQuoteCode(symbolInput) {
    const symbol = normalizeSymbol(symbolInput).replace(/[._-]/g, "");
    let match = symbol.match(/^HK(\d{5})$/) || symbol.match(/^(\d{5})HK$/);
    if (match) return "hk" + match[1];
    if (/^\d{5}$/.test(symbol)) return "hk" + symbol;

    match = symbol.match(/^(SH|SZ|BJ)(\d{6})$/) || symbol.match(/^(\d{6})(SH|SZ|BJ)$/);
    if (match) {
      const exchangeFirst = /^[A-Z]/.test(match[1]);
      const digits = exchangeFirst ? match[2] : match[1];
      const explicitExchange = exchangeFirst ? match[1] : match[2];
      const exchange = resolveAShareExchange(digits, explicitExchange);
      return exchange.toLowerCase() + digits;
    }
    if (/^\d{6}$/.test(symbol)) return inferAShareExchange(symbol).toLowerCase() + symbol;
    throw new Error("股票代码格式无效：" + symbolInput + "。港股示例 HK00700，A 股示例 600519");
  }

  async quote(symbolInput) {
    const code = this.toQuoteCode(symbolInput);
    let response;
    try {
      response = await this.fetchImpl("http://qt.gtimg.cn/q=" + code + "&_=" + Date.now(), {
        signal: AbortSignal.timeout(8_000),
        headers: { "User-Agent": "SpreadSentinel/1.0", "Cache-Control": "no-cache" },
      });
    } catch (error) {
      throw new Error(fetchError(error));
    }
    if (!response.ok) throw new Error("腾讯行情源返回 HTTP " + response.status);

    const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
    const line = text.split(";").map((item) => item.trim()).find((item) => item.startsWith("v_" + code + "="));
    if (!line) throw new Error("腾讯行情源未返回 " + code + " 的行情");
    const payload = line.slice(line.indexOf('="') + 2).replace(/"$/, "");
    const fields = payload.split("~");
    const price = Number(fields[3]);
    const previousClose = Number(fields[4]);
    if (!fields[1] || !Number.isFinite(price) || price <= 0) throw new Error(code + " 当前没有有效行情");

    const receivedAt = new Date().toISOString();
    const sourceTimestamp = parseTencentQuoteTimestamp(fields[31]);
    return {
      symbol: code,
      name: fields[1],
      price,
      previousClose: Number.isFinite(previousClose) ? previousClose : null,
      timestamp: sourceTimestamp || receivedAt,
      sourceTimestamp,
      receivedAt,
      provider: this.name,
    };
  }
}
export class EastMoneyHKProvider {
  constructor({ fetchImpl = fetch } = {}) {
    this.name = "eastmoney-hk";
    this.fetchImpl = fetchImpl;
  }

  toSecId(symbolInput) {
    const symbol = normalizeSymbol(symbolInput).replace(/[._-]/g, "");
    const match = symbol.match(/^HK(\d{5})$/) || symbol.match(/^(\d{5})HK$/) || symbol.match(/^(\d{5})$/);
    if (match === null) throw new Error("东方财富港股行情仅支持五位港股代码：" + symbolInput);
    return "116." + match[1];
  }

  async quote(symbolInput) {
    const secid = this.toSecId(symbolInput);
    const url = new URL("https://push2delay.eastmoney.com/api/qt/stock/get");
    url.searchParams.set("secid", secid);
    url.searchParams.set("fields", "f43,f58,f59,f60,f86");
    let lastError;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          signal: AbortSignal.timeout(8_000),
          headers: { "Referer": "https://quote.eastmoney.com/", "User-Agent": "Mozilla/5.0" },
        });
        if (response.ok === false) throw new Error("港股行情源返回 HTTP " + response.status);
        const data = (await response.json())?.data;
        if (data == null || Number.isFinite(Number(data.f43)) === false || Number(data.f43) <= 0) throw new Error(secid + " 无有效港股行情");

        const precision = Number.isInteger(Number(data.f59)) && Number(data.f59) >= 0 ? Number(data.f59) : 3;
        const scale = 10 ** precision;
        const quoteTimestamp = Number(data.f86);
        if (Number.isFinite(quoteTimestamp) === false || quoteTimestamp <= 0) throw new Error(secid + " 缺少有效行情时间");
        return {
          symbol: "hk" + secid.slice(4),
          name: data.f58 || secid,
          price: Number(data.f43) / scale,
          previousClose: Number.isFinite(Number(data.f60)) ? Number(data.f60) / scale : null,
          timestamp: new Date(quoteTimestamp * 1_000).toISOString(),
          provider: this.name,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(fetchError(lastError));
  }
}

export function toEastMoneySecId(symbolInput) {
  const normalized = normalizeSymbol(symbolInput);
  const match = normalized.match(/^(?:(SH|SZ|BJ)[.-]?)?(\d{6})(?:[.-]?(SH|SZ|BJ))?$/);
  if (!match) throw new Error("东方财富行情仅支持 A 股六位代码：" + normalized);
  const exchange = resolveAShareExchange(match[2], match[1] || match[3]);
  const market = exchange === "SH" ? "1" : "0";
  return { secid: market + "." + match[2], symbol: match[2] + "." + exchange };
}

export class EastMoneyProvider {
  constructor({ fetchImpl = fetch } = {}) {
    this.name = "eastmoney";
    this.fetchImpl = fetchImpl;
  }

  async quote(symbolInput) {
    const { secid, symbol } = toEastMoneySecId(symbolInput);
    const url = new URL("https://push2.eastmoney.com/api/qt/stock/get");
    url.searchParams.set("secid", secid);
    url.searchParams.set("fields", "f43,f57,f58,f59,f60");

    let response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
    } catch (error) {
      throw new Error("连接行情源失败：" + error.message);
    }
    if (!response.ok) throw new Error("行情源返回 HTTP " + response.status);
    const payload = await response.json();
    const data = payload?.data;
    if (!data || !Number.isFinite(Number(data.f43)) || Number(data.f43) <= 0) throw new Error("未找到 " + symbol + " 的有效行情");

    const precision = Number.isInteger(Number(data.f59)) ? Number(data.f59) : 2;
    const priceScale = 10 ** precision;

    return {
      symbol,
      name: data.f58 || symbol,
      price: Number(data.f43) / priceScale,
      previousClose: Number(data.f60) / priceScale,
      timestamp: new Date().toISOString(),
      provider: this.name,
    };
  }
}

export class RoutedMarketProvider {
  constructor({
    aShareProvider = new EastMoneyProvider(),
    aShareFallbackProvider = new TencentQuoteProvider(),
    hongKongProvider = new EastMoneyHKProvider(),
    searchProvider = new EastMoneySymbolSearchProvider(),
  } = {}) {
    this.name = "eastmoney";
    this.aShareProvider = aShareProvider;
    this.aShareFallbackProvider = aShareFallbackProvider;
    this.hongKongProvider = hongKongProvider;
    this.searchProvider = searchProvider;
  }

  search(query) {
    return this.searchProvider.search(query);
  }

  async quote(symbolInput) {
    if (isHongKongSymbol(symbolInput)) return this.hongKongProvider.quote(symbolInput);

    try {
      return await this.aShareProvider.quote(symbolInput);
    } catch (primaryError) {
      if (/不一致|格式无效|仅支持/.test(primaryError.message)) throw primaryError;
      try {
        return await this.aShareFallbackProvider.quote(symbolInput);
      } catch (fallbackError) {
        throw new Error("行情获取失败：东方财富：" + primaryError.message + "；腾讯：" + fallbackError.message);
      }
    }
  }
}

export function createMarketProvider(name = "auto") {
  const normalized = String(name).toLowerCase();
  if (normalized === "tencent") return new TencentQuoteProvider();
  if (normalized === "eastmoney" || normalized === "auto") return new RoutedMarketProvider();
  throw new Error("不支持的行情源：" + name + "，可选值为 tencent 或 eastmoney");
}
