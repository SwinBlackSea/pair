import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, sendJson, serveStatic } from "./http.js";
import { createMarketProvider } from "./market.js";
import { TelegramNotifier } from "./notifier.js";
import { StrategyService } from "./service.js";
import { StrategyStore } from "./store.js";

const currentDir = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(currentDir, "../public");
const port = Number(process.env.PORT || 3000);
const intervalMinutes = Number(process.env.REFRESH_INTERVAL_MINUTES || 10);
const tradingHoursOnly = ["1", "true", "yes"].includes(String(process.env.TRADING_HOURS_ONLY || "true").toLowerCase());
const dataFile = process.env.DATA_FILE || "./data/strategies.json";

if (!Number.isFinite(port) || port <= 0) throw new Error("PORT 必须是有效端口");
if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) throw new Error("REFRESH_INTERVAL_MINUTES 必须大于 0");

const store = new StrategyStore(dataFile);
await store.init();
const market = createMarketProvider(process.env.MARKET_PROVIDER || "auto");
const notifier = new TelegramNotifier({
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
});
const service = new StrategyService({
  store, market, notifier, intervalMs: intervalMinutes * 60_000, tradingHoursOnly,
});
await service.initializeTriggerHistory();
service.startScheduler();

async function fetchHkdCnyRate() {
  const response = await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error("ECB 汇率请求失败（" + response.status + "）");
  const xml = await response.text();
  const asOf = xml.match(/Cube time='([^']+)'/i)?.[1];
  const rates = Object.fromEntries(Array.from(xml.matchAll(/currency='([A-Z]{3})' rate='([^']+)'/g), (match) => [match[1], Number(match[2])]));
  if (!asOf || !(rates.CNY > 0) || !(rates.HKD > 0)) throw new Error("ECB 汇率响应无效");
  return { from: "HKD", to: "CNY", rate: rates.CNY / rates.HKD, asOf, source: "ECB" };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const path = url.pathname;

  try {
    if (path === "/api/health" && request.method === "GET") {
      return sendJson(response, 200, { ok: true, time: new Date().toISOString() });
    }
    if (path === "/api/system" && request.method === "GET") {
      return sendJson(response, 200, service.status());
    }
    if (path === "/api/symbols/search" && request.method === "GET") {
      const query = url.searchParams.get("q")?.trim() || "";
      if (query.length > 40) throw Object.assign(new Error("\u641c\u7d22\u5173\u952e\u8bcd\u4e0d\u80fd\u8d85\u8fc7 40 \u4e2a\u5b57\u7b26"), { statusCode: 400 });
      const items = query ? await market.search(query) : [];
      return sendJson(response, 200, { items });
    }
    if (path === "/api/quotes" && request.method === "GET") {
      const symbol = url.searchParams.get("symbol")?.trim() || "";
      if (!symbol) throw Object.assign(new Error("缺少标的代码"), { statusCode: 400 });
      if (symbol.length > 40) throw Object.assign(new Error("标的代码不能超过 40 个字符"), { statusCode: 400 });
      return sendJson(response, 200, await market.quote(symbol));
    }
    if (path === "/api/exchange-rate/hkd-cny" && request.method === "GET") {
      return sendJson(response, 200, await fetchHkdCnyRate());
    }
    if (path === "/api/strategies" && request.method === "GET") {
      return sendJson(response, 200, { items: service.list({ includeDeleted: url.searchParams.get("includeDeleted") === "true" }) });
    }
    if (path === "/api/trigger-history" && request.method === "GET") {
      return sendJson(response, 200, { items: service.listTriggerHistory() });
    }
    if (path === "/api/strategies" && request.method === "POST") {
      const item = await service.create(await readJson(request));
      return sendJson(response, 201, item);
    }
    if (path === "/api/refresh" && request.method === "POST") {
      const result = await service.refreshAll();
      return sendJson(response, result.failed ? 207 : 200, result);
    }

    const restoreMatch = path.match(/^\/api\/strategies\/([^/]+)\/restore$/);
    if (restoreMatch && request.method === "POST") {
      return sendJson(response, 200, await service.restore(restoreMatch[1]));
    }

    const strategyMatch = path.match(/^\/api\/strategies\/([^/]+)$/);
    if (strategyMatch && request.method === "GET") {
      const item = service.get(strategyMatch[1]);
      return item ? sendJson(response, 200, item) : sendJson(response, 404, { error: "策略不存在" });
    }
    if (strategyMatch && (request.method === "PATCH" || request.method === "PUT")) {
      const item = await service.update(strategyMatch[1], await readJson(request));
      return sendJson(response, 200, item);
    }
    if (strategyMatch && request.method === "DELETE") {
      await service.remove(strategyMatch[1]);
      response.writeHead(204);
      return response.end();
    }

    const refreshMatch = path.match(/^\/api\/strategies\/([^/]+)\/refresh$/);
    if (refreshMatch && request.method === "POST") {
      const item = await service.refreshOne(refreshMatch[1]);
      return sendJson(response, 200, item);
    }

    const triggerHistoryMatch = path.match(/^\/api\/trigger-history\/([^/]+)$/);
    if (triggerHistoryMatch && request.method === "PATCH") {
      const item = await service.updateTriggerHistory(triggerHistoryMatch[1], await readJson(request));
      return sendJson(response, 200, item);
    }

    if (path.startsWith("/api/")) return sendJson(response, 404, { error: "接口不存在" });
    if (request.method === "GET" || request.method === "HEAD") {
      const found = await serveStatic(response, publicDir, path);
      if (found) return;
    }
    sendJson(response, 404, { error: "页面不存在" });
  } catch (error) {
    console.error(`[${request.method}] ${path}`, error);
    sendJson(response, error.statusCode || 500, { error: error.message || "服务器内部错误" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`价差哨兵已启动：http://localhost:${port}`);
  console.log(`行情源：${market.name}，自动刷新：每 ${intervalMinutes} 分钟`);
  console.log(`Telegram 通知：${notifier.enabled ? "已启用" : "未配置"}`);
  console.log(`自动刷新时段：${tradingHoursOnly ? "工作日 09:30–16:30" : "全天"}`);
});

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在停止服务…`);
  service.stopScheduler();
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
