import { randomUUID } from "node:crypto";
import {
  ACTIONS,
  SINGLE_TRIGGER_MODES,
  STRATEGY_TYPES,
  evaluateSingle,
  evaluateGrid,
  evaluateRange,
  evaluateSpread,
  normalizeSymbol,
  validateStrategyInput,
} from "./engine.js";
import { isStrategyTradingTime, nextStrategyTradingTime } from "./trading-hours.js";

export class StrategyService {
  constructor({ store, market, notifier = null, intervalMs = 600_000, tradingHoursOnly = true }) {
    this.store = store;
    this.market = market;
    this.notifier = notifier;
    this.intervalMs = intervalMs;
    this.tradingHoursOnly = tradingHoursOnly;
    this.timer = null;
    this.refreshing = false;
    this.refreshAllPromise = null;
    this.lastRefreshAt = null;
    this.nextRefreshAt = null;
  }

  list({ includeDeleted = false } = {}) {
    return this.store.all()
      .filter((item) => includeDeleted || !item.deletedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id, { includeDeleted = false } = {}) {
    const item = this.store.get(id);
    return item && (includeDeleted || !item.deletedAt) ? item : null;
  }

  async initializeTriggerHistory() {
    for (const strategy of this.store.all().filter((item) => !item.deletedAt)) {
      const history = Array.isArray(strategy.triggerHistory) ? strategy.triggerHistory : [];
      const isTriggered = strategy.lastEvaluation?.signal === "TRIGGERED";
      if (isTriggered && history.length === 0) history.push(this.makeTriggerEvent(strategy));
      if (!Array.isArray(strategy.triggerHistory) || strategy.triggerActive !== isTriggered) {
        await this.store.update(strategy.id, { triggerHistory: history, triggerActive: isTriggered });
      }
    }
  }

  listTriggerHistory() {
    return this.store.all().filter((strategy) => !strategy.deletedAt).flatMap((strategy) => (
      (strategy.triggerHistory || []).map((event) => this.withHistoricalResult(event))
    )).sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt));
  }

  async updateTriggerHistory(eventId, input) {
    const strategy = this.store.all().filter((item) => !item.deletedAt).find((item) => (
      (item.triggerHistory || []).some((event) => event.id === eventId)
    ));
    if (!strategy) throw Object.assign(new Error("触发记录不存在"), { statusCode: 404 });

    const status = String(input.status || "").toUpperCase();
    if (!["PENDING", "EXECUTED", "SKIPPED"].includes(status)) {
      throw Object.assign(new Error("处置状态无效"), { statusCode: 400 });
    }
    const history = strategy.triggerHistory.map((event) => {
      if (event.id !== eventId) return event;
      if (status !== "EXECUTED") {
        return { ...event, status, execution: null, resolvedAt: status === "SKIPPED" ? new Date().toISOString() : null };
      }

      const expectedLegs = this.executionLegsFor(event);
      const supplied = Array.isArray(input.legs) ? input.legs : [];
      const legs = expectedLegs.map((expected) => {
        const leg = supplied.find((item) => normalizeSymbol(item.symbol) === expected.symbol && item.side === expected.side);
        const price = Number(leg?.price);
        const quantity = Number(leg?.quantity);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
          throw Object.assign(new Error(`${expected.symbol} 的执行价格和数量必须大于 0`), { statusCode: 400 });
        }
        return { ...expected, price, quantity };
      });
      const currencies = new Set(legs.map((leg) => this.currencyForSymbol(leg.symbol)));
      let fx = null;
      if (currencies.has("HKD") && currencies.has("CNY")) {
        const rate = Number(input.fxRate);
        if (!Number.isFinite(rate) || rate <= 0) throw Object.assign(new Error("港币兑人民币汇率必须大于 0"), { statusCode: 400 });
        fx = { from: "HKD", to: "CNY", rate, asOf: String(input.fxAsOf || ""), source: String(input.fxSource || "手动") };
      }
      return {
        ...event,
        status,
        execution: {
          legs,
          fx,
          executedAt: new Date().toISOString(),
          result: this.calculateHistoricalResult(event, legs, fx),
        },
        resolvedAt: new Date().toISOString(),
      };
    });
    const updated = await this.store.update(strategy.id, { triggerHistory: history });
    return this.withHistoricalResult(history.find((event) => event.id === eventId));
  }

  status() {
    const strategies = this.store.all().filter((item) => !item.deletedAt);
    return {
      provider: this.market.name,
      telegramEnabled: Boolean(this.notifier?.enabled),
      tradingHoursOnly: this.tradingHoursOnly,
      intervalMinutes: this.intervalMs / 60_000,
      refreshing: this.refreshing,
      lastRefreshAt: this.lastRefreshAt,
      nextRefreshAt: this.nextRefreshAt,
      strategyCount: strategies.length,
      activeCount: strategies.filter((item) => item.enabled).length,
      triggeredCount: strategies.filter((item) => item.lastEvaluation?.signal === "TRIGGERED").length,
    };
  }

  async create(input) {
    const clean = this.cleanInput(input);
    let capturedQuotes = null;
    if (clean.type === STRATEGY_TYPES.SINGLE && clean.referencePrice == null && clean.symbolA) {
      capturedQuotes = [await this.market.quote(clean.symbolA)];
      clean.referencePrice = capturedQuotes[0].price;
    }
    const errors = validateStrategyInput(clean);
    if (errors.length) throw Object.assign(new Error(errors.join("；")), { statusCode: 400 });

    const now = new Date().toISOString();
    const item = {
      id: randomUUID(),
      type: clean.type,
      name: clean.name,
      symbolA: clean.symbolA,
      symbolB: clean.type === STRATEGY_TYPES.SPREAD ? clean.symbolB : null,
      referencePrice: clean.type === STRATEGY_TYPES.SINGLE ? clean.referencePrice : null,
      triggerMode: clean.type === STRATEGY_TYPES.SINGLE ? clean.triggerMode : null,
      targetPrice: clean.type === STRATEGY_TYPES.SINGLE ? clean.targetPrice : null,
      basePriceA: clean.type === STRATEGY_TYPES.SPREAD ? clean.basePriceA : null,
      basePriceB: clean.type === STRATEGY_TYPES.SPREAD ? clean.basePriceB : null,
      lowerPrice: [STRATEGY_TYPES.GRID, STRATEGY_TYPES.RANGE].includes(clean.type) ? clean.lowerPrice : null,
      upperPrice: [STRATEGY_TYPES.GRID, STRATEGY_TYPES.RANGE].includes(clean.type) ? clean.upperPrice : null,
      gridCount: clean.type === STRATEGY_TYPES.GRID ? clean.gridCount : null,
      thresholdPct: [STRATEGY_TYPES.GRID, STRATEGY_TYPES.RANGE].includes(clean.type) ? null : clean.thresholdPct,
      direction: clean.type === STRATEGY_TYPES.SINGLE ? clean.direction : null,
      action: clean.type === STRATEGY_TYPES.SINGLE ? clean.action : clean.type === STRATEGY_TYPES.SPREAD ? ACTIONS.SELL_A_BUY_B : null,
      enabled: clean.enabled,
      notes: clean.notes,
      createdAt: now,
      updatedAt: now,
      lastEvaluation: null,
      triggerActive: false,
      triggerHistory: [],
    };

    const quotes = capturedQuotes || await this.fetchQuotes(item);
    if (item.type === STRATEGY_TYPES.SPREAD && item.basePriceA == null) {
      item.basePriceA = quotes[0].price;
      item.basePriceB = quotes[1].price;
    }
    item.lastEvaluation = this.evaluate(item, quotes, null);
    this.applyTriggerTransition(null, item);
    const created = await this.store.create(item);
    return this.notifyIfNeeded(null, created);
  }

  async update(id, input) {
    const existing = this.get(id);
    if (!existing) throw Object.assign(new Error("策略不存在"), { statusCode: 404 });

    const mergedInput = this.cleanInput({ ...existing, ...input });
    const errors = validateStrategyInput(mergedInput);
    if (errors.length) throw Object.assign(new Error(errors.join("；")), { statusCode: 400 });

    const pairChanged = mergedInput.type === STRATEGY_TYPES.SPREAD && (
      existing.type !== STRATEGY_TYPES.SPREAD
      || existing.symbolA !== mergedInput.symbolA
      || existing.symbolB !== mergedInput.symbolB
    );
    const manualBaselineSupplied = input.basePriceA !== undefined || input.basePriceB !== undefined;
    const manualBaselineChanged = manualBaselineSupplied && (
      Number(input.basePriceA) !== Number(existing.basePriceA)
      || Number(input.basePriceB) !== Number(existing.basePriceB)
    );
    const shouldCaptureBaseline = input.resetBaseline === true || (pairChanged && !manualBaselineChanged);
    const item = {
      ...existing,
      type: mergedInput.type,
      name: mergedInput.name,
      symbolA: mergedInput.symbolA,
      symbolB: mergedInput.type === STRATEGY_TYPES.SPREAD ? mergedInput.symbolB : null,
      referencePrice: mergedInput.type === STRATEGY_TYPES.SINGLE ? mergedInput.referencePrice : null,
      triggerMode: mergedInput.type === STRATEGY_TYPES.SINGLE ? mergedInput.triggerMode : null,
      targetPrice: mergedInput.type === STRATEGY_TYPES.SINGLE ? mergedInput.targetPrice : null,
      basePriceA: mergedInput.type === STRATEGY_TYPES.SPREAD ? mergedInput.basePriceA : null,
      basePriceB: mergedInput.type === STRATEGY_TYPES.SPREAD ? mergedInput.basePriceB : null,
      lowerPrice: [STRATEGY_TYPES.GRID, STRATEGY_TYPES.RANGE].includes(mergedInput.type) ? mergedInput.lowerPrice : null,
      upperPrice: [STRATEGY_TYPES.GRID, STRATEGY_TYPES.RANGE].includes(mergedInput.type) ? mergedInput.upperPrice : null,
      gridCount: mergedInput.type === STRATEGY_TYPES.GRID ? mergedInput.gridCount : null,
      thresholdPct: [STRATEGY_TYPES.GRID, STRATEGY_TYPES.RANGE].includes(mergedInput.type) ? null : mergedInput.thresholdPct,
      direction: mergedInput.type === STRATEGY_TYPES.SINGLE ? mergedInput.direction : null,
      action: mergedInput.type === STRATEGY_TYPES.SINGLE ? mergedInput.action : mergedInput.type === STRATEGY_TYPES.SPREAD ? ACTIONS.SELL_A_BUY_B : null,
      enabled: mergedInput.enabled,
      notes: mergedInput.notes,
      updatedAt: new Date().toISOString(),
    };

    const quotes = await this.fetchQuotes(item);
    if (shouldCaptureBaseline) {
      item.basePriceA = quotes[0].price;
      item.basePriceB = quotes[1].price;
    }
    if (item.type === STRATEGY_TYPES.SINGLE) {
      item.basePriceA = null;
      item.basePriceB = null;
    }
    item.lastEvaluation = this.evaluate(item, quotes, null);
    this.applyTriggerTransition(existing, item);
    const updated = await this.store.update(id, item);
    return this.notifyIfNeeded(existing, updated);
  }

  async remove(id) {
    const existing = this.get(id);
    if (!existing) throw Object.assign(new Error("策略不存在"), { statusCode: 404 });
    await this.store.update(id, {
      deletedAt: new Date().toISOString(),
      deletedEnabled: Boolean(existing.enabled),
      enabled: false,
      updatedAt: new Date().toISOString(),
    });
  }

  async restore(id) {
    const existing = this.get(id, { includeDeleted: true });
    if (!existing || !existing.deletedAt) throw Object.assign(new Error("回收站中未找到该策略"), { statusCode: 404 });
    return this.store.update(id, {
      deletedAt: null,
      deletedEnabled: null,
      enabled: false,
      updatedAt: new Date().toISOString(),
    });
  }

  async refreshOne(id) {
    const item = this.get(id);
    if (!item) throw Object.assign(new Error("策略不存在"), { statusCode: 404 });
    return this.performRefresh(item);
  }

  async performRefresh(item) {
    try {
      const quotes = await this.fetchQuotes(item);
      const changes = {
        lastEvaluation: this.evaluate(item, quotes),
        updatedAt: new Date().toISOString(),
      };
      this.applyTriggerTransition(item, changes);
      const updated = await this.store.update(item.id, changes);
      return this.notifyIfNeeded(item, updated);
    } catch (error) {
      const changes = {
        lastEvaluation: {
          signal: "ERROR",
          metricPct: null,
          message: error.message,
          refreshedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      };
      await this.store.update(item.id, changes);
      throw error;
    }
  }

  async refreshAll({ activeOnly = false, marketHoursOnly = false } = {}) {
    if (this.refreshAllPromise) return this.refreshAllPromise;
    this.refreshing = true;
    this.refreshAllPromise = (async () => {
      const now = new Date();
      const items = this.store.all().filter((item) => (
        !item.deletedAt
        && (
          (!activeOnly || item.enabled)
          && (!marketHoursOnly || isStrategyTradingTime(item, now))
        )
      ));
      const results = await Promise.allSettled(items.map((item) => this.performRefresh(item)));
      const refreshedAt = new Date().toISOString();
      this.lastRefreshAt = refreshedAt;
      return {
        refreshedAt,
        total: results.length,
        succeeded: results.filter((result) => result.status === "fulfilled").length,
        failed: results.filter((result) => result.status === "rejected").length,
        failures: results.flatMap((result, index) => result.status === "rejected"
          ? [{ id: items[index].id, name: items[index].name, message: result.reason.message }]
          : []),
      };
    })().finally(() => {
      this.refreshing = false;
      this.refreshAllPromise = null;
    });
    return this.refreshAllPromise;
  }

  async fetchQuotes(item) {
    if (item.type === STRATEGY_TYPES.SPREAD) {
      return Promise.all([this.market.quote(item.symbolA), this.market.quote(item.symbolB)]);
    }
    return [await this.market.quote(item.symbolA)];
  }

  evaluate(item, quotes, previousEvaluation = item.lastEvaluation) {
    if (item.type === STRATEGY_TYPES.SPREAD) return evaluateSpread(item, quotes[0], quotes[1]);
    if (item.type === STRATEGY_TYPES.GRID) return evaluateGrid(item, quotes[0], previousEvaluation);
    if (item.type === STRATEGY_TYPES.RANGE) return evaluateRange(item, quotes[0]);
    return evaluateSingle(item, quotes[0]);
  }

  executionLegsFor(strategyOrEvent) {
    const type = strategyOrEvent.type || strategyOrEvent.strategyType;
    if (type === STRATEGY_TYPES.SPREAD) {
      return [
        { symbol: strategyOrEvent.symbolA, side: "SELL", label: "卖出 A" },
        { symbol: strategyOrEvent.symbolB, side: "BUY", label: "买入 B" },
      ];
    }
    return [{
      symbol: strategyOrEvent.symbolA,
      side: (strategyOrEvent.action || strategyOrEvent.lastEvaluation?.action) === ACTIONS.BUY ? "BUY" : "SELL",
      label: (strategyOrEvent.action || strategyOrEvent.lastEvaluation?.action) === ACTIONS.BUY ? "买入" : "卖出",
    }];
  }

  makeTriggerEvent(strategy) {
    const evaluation = strategy.lastEvaluation || {};
    return {
      id: randomUUID(),
      strategyId: strategy.id,
      strategyName: strategy.name,
      strategyType: strategy.type,
      triggerMode: strategy.triggerMode,
      action: evaluation.action || strategy.action,
      symbolA: strategy.symbolA,
      symbolB: strategy.symbolB,
      metricPct: evaluation.metricPct ?? null,
      thresholdPct: strategy.thresholdPct,
      targetPrice: strategy.targetPrice,
      baselinePrices: strategy.type === STRATEGY_TYPES.SPREAD
        ? { [strategy.symbolA]: strategy.basePriceA, [strategy.symbolB]: strategy.basePriceB }
        : { [strategy.symbolA]: [STRATEGY_TYPES.GRID, STRATEGY_TYPES.RANGE].includes(strategy.type) ? (evaluation.gridPrice ?? evaluation.boundaryPrice) : strategy.referencePrice },
      triggerPrices: structuredClone(evaluation.prices || {}),
      quoteNames: structuredClone(evaluation.quoteNames || {}),
      message: evaluation.message || "策略已触发",
      triggeredAt: evaluation.refreshedAt || new Date().toISOString(),
      status: "PENDING",
      execution: null,
      resolvedAt: null,
    };
  }

  applyTriggerTransition(previous, next) {
    const evaluation = next.lastEvaluation;
    if (!evaluation) return;
    const history = structuredClone(previous?.triggerHistory || next.triggerHistory || []);
    const wasActive = previous
      ? (previous.triggerActive ?? previous.lastEvaluation?.signal === "TRIGGERED")
      : false;
    const isTriggered = evaluation.signal === "TRIGGERED";
    next.triggerHistory = history;
    const isGrid = (next.type || previous?.type) === STRATEGY_TYPES.GRID;
    next.triggerActive = isGrid ? false : isTriggered;
    if (isTriggered && (isGrid || !wasActive)) next.triggerHistory.push(this.makeTriggerEvent({ ...previous, ...next }));
  }

  currencyForSymbol(symbol) {
    const text = String(symbol);
    return text.startsWith("HK") || (text.length === 5 && Array.from(text).every((char) => char >= "0" && char <= "9")) ? "HKD" : "CNY";
  }

  calculateHistoricalResult(event, legs, fx = null) {
    const baselinePrices = event.baselinePrices || {};
    const legResults = legs.map((leg) => {
      const baselinePrice = Number(baselinePrices[leg.symbol]);
      if (!Number.isFinite(baselinePrice) || baselinePrice <= 0) return { ...leg, baselinePrice: null, pnl: null, returnPct: null };
      const direction = leg.side === "BUY" ? -1 : 1;
      return {
        ...leg,
        baselinePrice,
        pnl: (Number(leg.price) - baselinePrice) * Number(leg.quantity) * direction,
        returnPct: ((Number(leg.price) - baselinePrice) / baselinePrice) * 100 * direction,
      };
    });

    let relativeReturnPct = null;
    if (event.strategyType === STRATEGY_TYPES.SPREAD) {
      const sellA = legs.find((leg) => leg.symbol === event.symbolA && leg.side === "SELL");
      const buyB = legs.find((leg) => leg.symbol === event.symbolB && leg.side === "BUY");
      const baseA = Number(baselinePrices[event.symbolA]);
      const baseB = Number(baselinePrices[event.symbolB]);
      if (sellA && buyB && baseA > 0 && baseB > 0) {
        relativeReturnPct = (((sellA.price / baseA) / (buyB.price / baseB)) - 1) * 100;
      } else if (sellA && buyB) {
        const triggerA = Number(event.triggerPrices?.[event.symbolA]);
        const triggerB = Number(event.triggerPrices?.[event.symbolB]);
        const triggerFactor = 1 + Number(event.metricPct) / 100;
        if (triggerA > 0 && triggerB > 0 && triggerFactor > 0) {
          relativeReturnPct = (triggerFactor * (sellA.price / triggerA) / (buyB.price / triggerB) - 1) * 100;
        }
      }
    } else if (legResults.length) {
      relativeReturnPct = legResults[0].returnPct;
    }
    let totalPnlCny = null;
    if (legResults.every((leg) => Number.isFinite(leg.pnl))) {
      const currencies = new Set(legResults.map((leg) => this.currencyForSymbol(leg.symbol)));
      if (currencies.size === 1 && currencies.has("CNY")) totalPnlCny = legResults.reduce((sum, leg) => sum + leg.pnl, 0);
      if (currencies.has("HKD") && currencies.has("CNY") && fx?.rate > 0) {
        totalPnlCny = legResults.reduce((sum, leg) => sum + leg.pnl * (this.currencyForSymbol(leg.symbol) === "HKD" ? fx.rate : 1), 0);
      }
    }
    return { relativeReturnPct, legs: legResults, totalPnlCny, fx };
  }

  withHistoricalResult(event) {
    const result = event.execution?.legs
      ? this.calculateHistoricalResult(event, event.execution.legs, event.execution.fx)
      : null;
    return { ...event, historicalResult: result };
  }

  async notifyIfNeeded(previous, current) {
    if (!this.notifier?.enabled || !current?.enabled) return current;
    const isTriggered = current.lastEvaluation?.signal === "TRIGGERED";
    if (!isTriggered) return current;

    const wasTriggered = previous?.lastEvaluation?.signal === "TRIGGERED";
    const becameEnabled = previous && !previous.enabled && current.enabled;
    const retryFailed = wasTriggered && previous?.notification?.status === "FAILED";
    if (current.type !== STRATEGY_TYPES.GRID && wasTriggered && !becameEnabled && !retryFailed) return current;

    const attemptedAt = new Date().toISOString();
    try {
      await this.notifier.sendTriggered(current);
      return await this.store.update(current.id, {
        notification: { status: "SENT", attemptedAt, sentAt: new Date().toISOString(), error: null },
      });
    } catch (error) {
      console.error("[telegram] " + current.name, error.message);
      return await this.store.update(current.id, {
        notification: { status: "FAILED", attemptedAt, sentAt: null, error: error.message },
      });
    }
  }

  cleanInput(input) {
    return {
      ...input,
      type: input.type,
      name: String(input.name ?? "").trim().slice(0, 80),
      symbolA: normalizeSymbol(input.symbolA),
      symbolB: normalizeSymbol(input.symbolB),
      referencePrice: input.referencePrice === null || input.referencePrice === "" || input.referencePrice === undefined ? null : Number(input.referencePrice),
      triggerMode: input.triggerMode || SINGLE_TRIGGER_MODES.THRESHOLD_PCT,
      targetPrice: input.targetPrice === null || input.targetPrice === "" || input.targetPrice === undefined ? null : Number(input.targetPrice),
      basePriceA: input.basePriceA === null || input.basePriceA === "" || input.basePriceA === undefined ? null : Number(input.basePriceA),
      basePriceB: input.basePriceB === null || input.basePriceB === "" || input.basePriceB === undefined ? null : Number(input.basePriceB),
      lowerPrice: input.lowerPrice === null || input.lowerPrice === "" || input.lowerPrice === undefined ? null : Number(input.lowerPrice),
      upperPrice: input.upperPrice === null || input.upperPrice === "" || input.upperPrice === undefined ? null : Number(input.upperPrice),
      gridCount: input.gridCount === null || input.gridCount === "" || input.gridCount === undefined ? null : Number(input.gridCount),
      thresholdPct: Number(input.thresholdPct),
      direction: input.direction,
      action: input.action,
      enabled: input.enabled !== false,
      notes: String(input.notes ?? "").trim().slice(0, 500),
    };
  }

  startScheduler() {
    if (this.timer) return;
    this.scheduleNextRun(new Date());
  }

  scheduleNextRun(earliest) {
    const activeStrategies = this.store.all().filter((item) => item.enabled && !item.deletedAt);
    let target = new Date(earliest);
    if (this.tradingHoursOnly && activeStrategies.length) {
      target = activeStrategies
        .map((item) => nextStrategyTradingTime(item, target))
        .reduce((soonest, candidate) => candidate < soonest ? candidate : soonest);
    }
    this.nextRefreshAt = target.toISOString();
    const delay = Math.max(0, target.valueOf() - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refreshAll({ activeOnly: true, marketHoursOnly: this.tradingHoursOnly }).catch((error) => {
        console.error("[scheduler] refresh failed", error);
      }).finally(() => {
        this.scheduleNextRun(new Date(Date.now() + this.intervalMs));
      });
    }, delay);
    this.timer.unref();
  }

  stopScheduler() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRefreshAt = null;
  }
}
