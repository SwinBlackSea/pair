# 港股行情源：东方财富 push2delay（准实时）

> 覆盖旧方案（腾讯 gtimg 拉港股）。原因：**腾讯 gtimg 港股固定 15 分钟延迟**（实测 00700 的行情时间戳滞后当前约 15 分钟），而**东方财富 push2delay 港股准实时**（实测行情时间戳=当下 unix 秒，价格滞后仅约 2 秒），且 43 号机**直连可达**。
> 本方案供 codex 据此把 `src/market.js` 的港股行情源从腾讯 gtimg 更换为东财 push2delay。由 Hermes 于 2026-08-26 整理。

## 一、为什么用 push2delay（43 号机直连实测，2026-08-26）

| 东财端点 | 43 直连可达性 | 港股时间戳 |
|---|---|---|
| `push2.eastmoney.com` | ❌ 被 43 IP 的 WAF 风控（返回空 / 502，连 A股都 502） | — |
| **`push2delay.eastmoney.com`** | ✅ **可达** | ✅ **准实时**（f86=当下，滞后 ~2 秒） |

实测数据：`f86=1787711123` vs 43 now=1787711125（只差 2 秒）；泡泡玛特 `f86=1787711125`（=当下）。

**结论：43 直接调 push2delay 即可拿港股准实时，无需 ssh 中转。** 请注意不要用 push2 主域（被 43 的 WAF 挡）。

## 二、接口

```
GET https://push2delay.eastmoney.com/api/qt/stock/get?secid=116.00700&fields=f43,f58,f59,f60,f86
```
- **必须带 `Referer: https://quote.eastmoney.com/`**（否则被拒）；建议再加 `User-Agent: Mozilla/5.0`。
- **secid**：港股 = `116.` + 5 位代码（`00700`→`116.00700`，`09992`→`116.09992`）。A股用 `1.`沪 / `0.`深 + 6 位（本方案只管港股，勿混淆）。

## 三、响应字段（JSON `data`）

| 字段 | 含义 | 取值 |
|---|---|---|
| `f43` | 现价（整型） | `price = f43 / 10**f59` |
| `f58` | 名称 | `name` |
| `f59` | 精度位数 | 如 3 → `10**3=1000` |
| `f60` | 昨收（整型） | `previousClose = f60 / 10**f59` |
| `f86` | **行情时间戳（unix 秒）** | `timestamp = new Date(f86*1000).toISOString()` |

> ⚠️ `f43`/`f60` 是**整型缩放**（东财精度），**必须除以 `10**f59`**，而不是像腾讯 gtimg 那样直接当 float 用。
> ⚠️ `f86` 是 **unix 秒**，记得 ×1000 转毫秒再给 `Date`。
> ✅ `timestamp` 请用 **`f86`（真实行情时间）** 而不是 `new Date()`（请求完成时间），这是相对旧 provider 的改进。

## 四、返回结构（与现有 provider 完全一致，上层零改动）

```javascript
{ symbol, name, price, previousClose, timestamp, provider }
```
- `symbol` 需与现有 `TencentQuoteProvider.quote` 一致：小写 `hk00700`（对归一化后的输入，如 `00700`/`hk00700`/`00700.HK` 都应归一到它）。
- `provider` 建议 `"eastmoney"`（或 `"eastmoney-hk"`）。

## 五、实现：在 `src/market.js` 新增 `EastMoneyHKProvider`

可参照现有 `TencentQuoteProvider` 骨架，但改成东财逻辑：

```javascript
export class EastMoneyHKProvider {
  constructor({ fetchImpl = fetch } = {}) { this.name = "eastmoney"; this.fetchImpl = fetchImpl; }

  toSecId(symbolInput) {
    // 复用/参考 normalizeSymbol + toQuoteCode 的字符合并逻辑，提取 5 位港股代码 → "116." + 5位
    const digits = /* 从 symbolInput 提取 5 位数字，兼容 00700 / hk00700 / 00700.HK */;
    return "116." + digits;
  }

  async quote(symbolInput) {
    const secid = this.toSecId(symbolInput);
    const url = new URL("https://push2delay.eastmoney.com/api/qt/stock/get");
    url.searchParams.set("secid", secid);
    url.searchParams.set("fields", "f43,f58,f59,f60,f86");
    let resp;
    try {
      resp = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(8_000),
        headers: { "Referer": "https://quote.eastmoney.com/", "User-Agent": "Mozilla/5.0" },
      });
    } catch (e) { throw new Error("连接行情源失败：" + e.message); }
    if (!resp.ok) throw new Error("港股行情源返回 HTTP " + resp.status);
    const data = (await resp.json()).data;
    if (!data || !Number.isFinite(Number(data.f43))) throw new Error(`${secid} 无有效港股行情`);
    const prec = Math.max(0, Number(data.f59) || 3);
    return {
      symbol: "hk" + secid.slice(4),
      name: data.f58 || secid,
      price: Number(data.f43) / (10 ** prec),
      previousClose: Number.isFinite(Number(data.f60)) ? Number(data.f60) / (10 ** prec) : null,
      timestamp: new Date(Number(data.f86) * 1000).toISOString(),
      provider: this.name,
    };
  }
}
```

## 六、接入（两处）

1. `RoutedMarketProvider` 构造函数里，把默认 `hongKongProvider = new TencentQuoteProvider()` 换成 `new EastMoneyHKProvider()`。可选：给港股再加一个腾讯 gtimg 作为最终兜底（东财临时失败时退回 15min 延迟价，至少不无数据）。
2. 若改了 `createMarketProvider("eastmoney")` 返回的 `name`（当前是 `"eastmoney+tencent"`），同步更新 `test/market.test.js` 第 144 行断言。

## 七、测试 & 验收清单

- [ ] 新增 `EastMoneyHKProvider` 单测：用 `Response.json({ data: { f43: 448800, f58: "腾讯控股", f59: 3, f60: 442000, f86: <当前秒> } })` 断言 `price===448.8`、`previousClose===442`、`timestamp` 解析为当下时间。
- [ ] 保留腾讯现有测试（`TencentQuoteProvider` 仍可作独立可选/兜底用）。
- [ ] `npm test` 全部通过（现有单测不回归）。
- [ ] `MARKET_PROVIDER=auto`（或对应路由配置）`npm start`，添加 `hk00700`（腾讯）策略能取到**准实时**价（页面/接口看时间戳=当下，不再是 15min 前）；A股 `600519`/`513310` 不回归。

## 八、坑（务必注意）

- `Referer` 头不能省，否则东财 Forbidden。
- `f43`/`f60` 整型须 `/10**f59`；`f86` 是 unix **秒** ×1000。
- 港股 secid 前缀 `116.`；A股另用 `1.`/`0.`，勿混用。
- 43 千万别用 `push2` 主域（被 WAF 挡），一律走 `push2delay`。
- 东财偶发抖动（瞬时 `exit 56`/空响应）→ 在 quote 层重试 1–2 次或并入现有 fallback，别让它一次失败就整条策略报 ERROR。
```