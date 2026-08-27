import test from "node:test";
import assert from "node:assert/strict";
import { isStrategyTradingTime, nextStrategyTradingTime } from "../src/trading-hours.js";

const strategy = { symbolA: "513310" };

test("工作日固定在北京时间 09:30 至 16:30 刷新", () => {
  assert.equal(isStrategyTradingTime(strategy, new Date("2026-08-26T01:29:00Z")), false);
  assert.equal(isStrategyTradingTime(strategy, new Date("2026-08-26T01:30:00Z")), true);
  assert.equal(isStrategyTradingTime(strategy, new Date("2026-08-26T04:00:00Z")), true);
  assert.equal(isStrategyTradingTime(strategy, new Date("2026-08-26T08:29:00Z")), true);
  assert.equal(isStrategyTradingTime(strategy, new Date("2026-08-26T08:30:00Z")), false);
});

test("闭市后计算下一工作日 09:30", () => {
  assert.equal(
    nextStrategyTradingTime(strategy, new Date("2026-08-26T09:00:00Z")).toISOString(),
    "2026-08-27T01:30:00.000Z",
  );
  assert.equal(
    nextStrategyTradingTime(strategy, new Date("2026-08-28T09:00:00Z")).toISOString(),
    "2026-08-31T01:30:00.000Z",
  );
});
