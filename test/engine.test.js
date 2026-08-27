import test from "node:test";
import assert from "node:assert/strict";
import { evaluateGrid, evaluateRange, evaluateSingle, evaluateSpread, validateStrategyInput } from "../src/engine.js";

test("单股上涨达到阈值时触发卖出", () => {
  const result = evaluateSingle({
    type: "SINGLE",
    symbolA: "600519.SH",
    referencePrice: 100,
    thresholdPct: 5,
    direction: "RISE",
    action: "SELL",
  }, { price: 106, name: "测试股票", timestamp: "2026-01-01T00:00:00.000Z" });

  assert.equal(result.signal, "TRIGGERED");
  assert.equal(result.metricPct, 6);
  assert.match(result.message, /提示卖出/);
});

test("单股下跌尚未达到阈值时继续等待", () => {
  const result = evaluateSingle({
    type: "SINGLE",
    symbolA: "000001.SZ",
    referencePrice: 100,
    thresholdPct: 5,
    direction: "FALL",
    action: "BUY",
  }, { price: 97 });

  assert.equal(result.signal, "WAITING");
  assert.equal(result.metricPct, -3);
  assert.equal(result.rawReturnPct, -3);
  assert.equal(result.message, "当前价差 -3% / 触发线 -5%");
});

test("上涨策略在当前下跌时保留负号", () => {
  const result = evaluateSingle({
    type: "SINGLE", symbolA: "HK00700", referencePrice: 443, thresholdPct: 10,
    direction: "RISE", action: "SELL",
  }, { price: 442 });

  assert.equal(result.metricPct, -0.2257);
  assert.equal(result.rawReturnPct, -0.2257);
  assert.equal(result.message, "当前价差 -0.23% / 触发线 +10%");
});
test("上涨目标价按当前价计算尚需涨幅", () => {
  const result = evaluateSingle({
    type: "SINGLE", symbolA: "HK00700", referencePrice: 447, targetPrice: 500,
    triggerMode: "TARGET_PRICE", direction: "RISE", action: "SELL",
  }, { price: 448.4 });

  assert.equal(result.signal, "WAITING");
  assert.equal(result.metricPct, 2.6415);
  assert.equal(result.rawReturnPct, 2.6415);
  assert.equal(result.targetProgressPct, 2.6415);
  assert.match(result.message, /相对基准 \+2.64%/);
});


test("下跌目标在价格上涨时显示正价差", () => {
  const result = evaluateSingle({
    type: "SINGLE", symbolA: "HK00700", referencePrice: 100, thresholdPct: 10,
    direction: "FALL", action: "BUY",
  }, { price: 102 });

  assert.equal(result.metricPct, 2);
  assert.equal(result.rawReturnPct, 2);
});

test("A 相对 B 超额收益按累计净值比计算", () => {
  const result = evaluateSpread({
    type: "SPREAD",
    symbolA: "A",
    symbolB: "B",
    basePriceA: 100,
    basePriceB: 50,
    thresholdPct: 5,
  }, { price: 110 }, { price: 50 });

  assert.equal(result.signal, "TRIGGERED");
  assert.equal(result.metricPct, 10);
  assert.match(result.message, /卖 A 买 B/);
});

test("网格向上跨档触发卖出，向下跨档触发买入", () => {
  const strategy = { type: "GRID", symbolA: "A", lowerPrice: 100, upperPrice: 120, gridCount: 4 };
  const initial = evaluateGrid(strategy, { price: 106 });
  assert.equal(initial.signal, "WAITING");
  assert.equal(initial.gridIndex, 1);
  assert.equal(initial.stepPrice, 5);

  const rise = evaluateGrid(strategy, { price: 116 }, initial);
  assert.equal(rise.signal, "TRIGGERED");
  assert.equal(rise.action, "SELL");
  assert.equal(rise.crossedCount, 2);
  assert.equal(rise.gridPrice, 115);

  const fall = evaluateGrid(strategy, { price: 109 }, rise);
  assert.equal(fall.action, "BUY");
  assert.equal(fall.crossedCount, 2);
  assert.equal(fall.gridPrice, 115);
});

test("区间策略在下限买入、上限卖出", () => {
  const strategy = { type: "RANGE", symbolA: "A", lowerPrice: 90, upperPrice: 110 };
  const inside = evaluateRange(strategy, { price: 100 });
  assert.equal(inside.signal, "WAITING");
  assert.equal(inside.rangeStatus, "INSIDE");

  const lower = evaluateRange(strategy, { price: 90 });
  assert.equal(lower.signal, "TRIGGERED");
  assert.equal(lower.action, "BUY");
  assert.equal(lower.boundaryPrice, 90);

  const upper = evaluateRange(strategy, { price: 111 });
  assert.equal(upper.action, "SELL");
  assert.equal(upper.boundaryPrice, 110);
});

test("区间策略只校验上下边界，不要求网格数量和阈值", () => {
  assert.deepEqual(validateStrategyInput({
    type: "RANGE", name: "A 区间", symbolA: "A", lowerPrice: 90, upperPrice: 110,
  }), []);
});

test("网格参数必须具有有效区间和数量", () => {
  const errors = validateStrategyInput({
    type: "GRID", name: "错误网格", symbolA: "A", lowerPrice: 120, upperPrice: 100, gridCount: 1,
  });
  assert.ok(errors.some((message) => message.includes("上限必须高于下限")));
  assert.ok(errors.some((message) => message.includes("2 到 200")));
  assert.ok(!errors.some((message) => message.includes("阈值")));
});

test("校验会拒绝相同的 A、B 代码", () => {
  const errors = validateStrategyInput({
    type: "SPREAD",
    name: "错误价差",
    symbolA: "600000.SH",
    symbolB: "600000.SH",
    thresholdPct: 3,
  });
  assert.ok(errors.some((message) => message.includes("不能相同")));
});
