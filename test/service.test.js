import test from "node:test";
import assert from "node:assert/strict";
import { StrategyService } from "../src/service.js";
import { TelegramNotifier } from "../src/notifier.js";

class MemoryStore {
  constructor() { this.items = []; }
  all() { return structuredClone(this.items); }
  get(id) { return structuredClone(this.items.find((item) => item.id === id) || null); }
  async create(item) { this.items.push(structuredClone(item)); return this.get(item.id); }
  async update(id, changes) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    this.items[index] = { ...this.items[index], ...structuredClone(changes) };
    return this.get(id);
  }
  async remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    return this.items.length !== before;
  }
}

class FixedMarket {
  constructor() { this.name = "fixed"; this.prices = { A: 100, B: 50 }; }
  async quote(symbol) { return { symbol, name: symbol, price: this.prices[symbol], timestamp: "2026-01-01T00:00:00.000Z" }; }
}

class RecordingNotifier {
  constructor() { this.enabled = true; this.messages = []; }
  async sendTriggered(strategy) { this.messages.push(strategy.name); }
}

test("默认仅在交易时段自动刷新", () => {
  const service = new StrategyService({ store: new MemoryStore(), market: new FixedMarket() });
  assert.equal(service.status().tradingHoursOnly, true);
});

test("创建价差策略时自动采集两边基准价格", async () => {
  const store = new MemoryStore();
  const market = new FixedMarket();
  const service = new StrategyService({ store, market });
  const strategy = await service.create({
    type: "SPREAD",
    name: "A/B 轮动",
    symbolA: "A",
    symbolB: "B",
    thresholdPct: 5,
  });

  assert.equal(strategy.basePriceA, 100);
  assert.equal(strategy.basePriceB, 50);
  assert.equal(strategy.lastEvaluation.metricPct, 0);

  market.prices.A = 110;
  const refreshed = await service.refreshOne(strategy.id);
  assert.equal(refreshed.lastEvaluation.signal, "TRIGGERED");
});

test("创建单股策略时未填写基准价会自动采集当前价", async () => {
  const store = new MemoryStore();
  const market = new FixedMarket();
  const service = new StrategyService({ store, market });
  const strategy = await service.create({
    type: "SINGLE", name: "自动基准", symbolA: "A",
    thresholdPct: 5, direction: "RISE", action: "SELL",
  });

  assert.equal(strategy.referencePrice, 100);
  assert.equal(strategy.lastEvaluation.metricPct, 0);
});

test("价差策略支持手动创建和编辑 A/B 基准价", async () => {
  const store = new MemoryStore();
  const market = new FixedMarket();
  const service = new StrategyService({ store, market });
  const strategy = await service.create({
    type: "SPREAD", name: "手动基准", symbolA: "A", symbolB: "B",
    basePriceA: 80, basePriceB: 40, thresholdPct: 5,
  });

  assert.equal(strategy.basePriceA, 80);
  assert.equal(strategy.basePriceB, 40);

  const edited = await service.update(strategy.id, { basePriceA: 90, basePriceB: 45 });
  assert.equal(edited.basePriceA, 90);
  assert.equal(edited.basePriceB, 45);

  market.prices.A = 120;
  market.prices.B = 60;
  const reset = await service.update(strategy.id, { resetBaseline: true });
  assert.equal(reset.basePriceA, 120);
  assert.equal(reset.basePriceB, 60);
  assert.equal(reset.lastEvaluation.metricPct, 0);

  market.prices.C = 30;
  const changedPair = await service.update(strategy.id, { symbolB: "C" });
  assert.equal(changedPair.basePriceA, 120);
  assert.equal(changedPair.basePriceB, 30);
});

test("价差策略拒绝只填写一边基准价", async () => {
  const service = new StrategyService({ store: new MemoryStore(), market: new FixedMarket() });
  await assert.rejects(service.create({
    type: "SPREAD", name: "不完整基准", symbolA: "A", symbolB: "B",
    basePriceA: 80, thresholdPct: 5,
  }), /必须同时填写或同时留空/);
});

test("列表按创建时间排序且不受更新时间影响", () => {
  const store = new MemoryStore();
  store.items = [
    { id: "older", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z" },
    { id: "newer", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" },
  ];
  const service = new StrategyService({ store, market: new FixedMarket() });
  assert.deepEqual(service.list().map((item) => item.id), ["newer", "older"]);
});

test("删除策略移入回收站且可恢复", async () => {
  const store = new MemoryStore();
  const market = new FixedMarket();
  const service = new StrategyService({ store, market });
  const strategy = await service.create({
    type: "SINGLE", name: "可恢复", symbolA: "A", referencePrice: 100, thresholdPct: 5, direction: "RISE", action: "SELL",
  });
  await service.remove(strategy.id);

  assert.equal(service.get(strategy.id), null);
  assert.equal(service.list().length, 0);
  const deleted = service.list({ includeDeleted: true })[0];
  assert.ok(deleted.deletedAt);
  assert.equal(deleted.enabled, false);

  const restored = await service.restore(strategy.id);
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.enabled, false);
  assert.equal(service.list().length, 1);
});

test("后台批量刷新只处理启用的策略", async () => {
  const store = new MemoryStore();
  const market = new FixedMarket();
  const service = new StrategyService({ store, market });
  await service.create({ type: "SINGLE", name: "启用", symbolA: "A", referencePrice: 100, thresholdPct: 2, direction: "RISE", action: "SELL" });
  await service.create({ type: "SINGLE", name: "暂停", symbolA: "B", referencePrice: 50, thresholdPct: 2, direction: "RISE", action: "SELL", enabled: false });

  const result = await service.refreshAll({ activeOnly: true });
  assert.equal(result.total, 1);
  assert.equal(result.succeeded, 1);
});


test("网格策略按每次跨档生成独立买卖历史", async () => {
  const store = new MemoryStore();
  const market = new FixedMarket();
  const service = new StrategyService({ store, market });
  const strategy = await service.create({
    type: "GRID", name: "A 网格", symbolA: "A", lowerPrice: 80, upperPrice: 120, gridCount: 4,
  });
  assert.equal(strategy.lastEvaluation.signal, "WAITING");
  assert.equal(strategy.lastEvaluation.gridIndex, 2);

  market.prices.A = 111;
  await service.refreshOne(strategy.id);
  market.prices.A = 99;
  await service.refreshOne(strategy.id);

  const history = service.listTriggerHistory();
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((event) => event.action), ["SELL", "BUY"]);
  assert.deepEqual(history.map((event) => event.baselinePrices.A), [110, 110]);
});

test("一条区间策略分别记录下限买入和上限卖出", async () => {
  const store = new MemoryStore();
  const market = new FixedMarket();
  const service = new StrategyService({ store, market });
  const strategy = await service.create({
    type: "RANGE", name: "A 高抛低吸", symbolA: "A", lowerPrice: 90, upperPrice: 110,
  });
  assert.equal(strategy.lastEvaluation.signal, "WAITING");

  market.prices.A = 89;
  await service.refreshOne(strategy.id);
  market.prices.A = 88;
  await service.refreshOne(strategy.id);
  assert.equal(service.listTriggerHistory().length, 1);

  market.prices.A = 100;
  await service.refreshOne(strategy.id);
  market.prices.A = 111;
  await service.refreshOne(strategy.id);
  const history = service.listTriggerHistory();
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((event) => event.action), ["BUY", "SELL"]);
  assert.deepEqual(history.map((event) => event.baselinePrices.A), [90, 110]);
});

test("Telegram 只在进入触发状态时通知一次", async () => {
  const store = new MemoryStore();
  const market = new FixedMarket();
  const notifier = new RecordingNotifier();
  const service = new StrategyService({ store, market, notifier });
  const strategy = await service.create({
    type: "SINGLE", name: "价格突破", symbolA: "A", referencePrice: 100,
    thresholdPct: 5, direction: "RISE", action: "SELL",
  });

  market.prices.A = 110;
  await service.refreshOne(strategy.id);
  await service.refreshOne(strategy.id);
  assert.deepEqual(notifier.messages, ["价格突破"]);

  market.prices.A = 100;
  await service.refreshOne(strategy.id);
  market.prices.A = 110;
  await service.refreshOne(strategy.id);
  assert.deepEqual(notifier.messages, ["价格突破", "价格突破"]);
});

test("Telegram 请求包含 chat_id 和触发信息", async () => {
  let request;
  const notifier = new TelegramNotifier({
    token: "test-token",
    chatId: "1262775371",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({ ok: true });
    },
  });
  await notifier.sendTriggered({
    type: "SPREAD", name: "A/B 轮动", symbolA: "HK00700", symbolB: "513310",
    thresholdPct: 10, lastEvaluation: { metricPct: 10.25, message: "提示卖 A 买 B" },
  });
  const body = JSON.parse(request.options.body);
  assert.equal(body.chat_id, "1262775371");
  assert.match(request.url, /sendMessage$/);
  assert.match(body.text, /A\/B 轮动/);
  assert.match(body.text, /\+10\.25%/);
});

test("Telegram 瞬时连接失败时自动重试", async () => {
  let attempts = 0;
  const notifier = new TelegramNotifier({
    token: "test-token",
    chatId: "1262775371",
    retryDelayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("fetch failed");
      return Response.json({ ok: true });
    },
  });

  await notifier.sendTriggered({
    type: "SINGLE", name: "重试通知", symbolA: "A", thresholdPct: 5,
    lastEvaluation: { metricPct: 6, message: "已触发" },
  });
  assert.equal(attempts, 3);
});

test("每次重新进入触发状态都会新增一条触发历史", async () => {
  const store = new MemoryStore();
  const market = new FixedMarket();
  const service = new StrategyService({ store, market });
  const strategy = await service.create({
    type: "SINGLE", name: "多次突破", symbolA: "A", referencePrice: 100,
    thresholdPct: 5, direction: "RISE", action: "SELL",
  });
  assert.equal(service.listTriggerHistory().length, 0);

  market.prices.A = 106;
  await service.refreshOne(strategy.id);
  await service.refreshOne(strategy.id);
  assert.equal(service.listTriggerHistory().length, 1);

  market.prices.A = 100;
  await service.refreshOne(strategy.id);
  market.prices.A = 108;
  await service.refreshOne(strategy.id);
  assert.equal(service.listTriggerHistory().length, 2);
});

test("触发历史按基准价和执行价计算固定历史收益", async () => {
  const store = new MemoryStore();
  const market = new FixedMarket();
  const service = new StrategyService({ store, market });
  const strategy = await service.create({
    type: "SINGLE", name: "执行卖出", symbolA: "A", referencePrice: 100,
    thresholdPct: 5, direction: "RISE", action: "SELL",
  });
  market.prices.A = 106;
  await service.refreshOne(strategy.id);
  const event = service.listTriggerHistory()[0];
  await service.updateTriggerHistory(event.id, {
    status: "EXECUTED",
    legs: [{ symbol: "A", side: "SELL", price: 106, quantity: 10 }],
  });
  market.prices.A = 103;
  await service.refreshOne(strategy.id);

  const executed = service.listTriggerHistory()[0];
  assert.equal(executed.status, "EXECUTED");
  assert.equal(executed.historicalResult.legs[0].pnl, 60);
  assert.equal(executed.historicalResult.legs[0].returnPct, 6);
  assert.equal(executed.historicalResult.relativeReturnPct, 6);
});

test("价差执行历史按实际成交价计算相对基准收益", async () => {
  const store = new MemoryStore();
  const market = new FixedMarket();
  const service = new StrategyService({ store, market });
  const strategy = await service.create({
    type: "SPREAD", name: "轮动收益", symbolA: "A", symbolB: "B",
    basePriceA: 100, basePriceB: 50, thresholdPct: 5,
  });
  market.prices.A = 106;
  const triggered = await service.refreshOne(strategy.id);
  const event = service.listTriggerHistory()[0];
  await service.updateTriggerHistory(event.id, {
    status: "EXECUTED",
    legs: [
      { symbol: "A", side: "SELL", price: 107, quantity: 10 },
      { symbol: "B", side: "BUY", price: 49, quantity: 20 },
    ],
  });
  market.prices.A = 90;
  market.prices.B = 60;
  await service.refreshOne(triggered.id);

  const executed = service.listTriggerHistory()[0];
  assert.equal(Number(executed.historicalResult.relativeReturnPct.toFixed(4)), 9.1837);
  assert.equal(executed.historicalResult.legs[0].pnl, 70);
  assert.equal(executed.historicalResult.legs[1].pnl, 20);
});

test("策略后续编辑不会改变历史记录的执行腿", async () => {
  const store = new MemoryStore();
  const market = new FixedMarket();
  const service = new StrategyService({ store, market });
  const strategy = await service.create({
    type: "SPREAD", name: "A/B 轮动", symbolA: "A", symbolB: "B", thresholdPct: 5,
  });
  market.prices.A = 110;
  await service.refreshOne(strategy.id);
  const event = service.listTriggerHistory()[0];

  await service.update(strategy.id, { symbolA: "B", symbolB: "A" });
  const executed = await service.updateTriggerHistory(event.id, {
    status: "EXECUTED",
    legs: [
      { symbol: "A", side: "SELL", price: 110, quantity: 10 },
      { symbol: "B", side: "BUY", price: 50, quantity: 20 },
    ],
  });

  assert.deepEqual(executed.execution.legs.map((leg) => [leg.symbol, leg.side]), [
    ["A", "SELL"], ["B", "BUY"],
  ]);
});
