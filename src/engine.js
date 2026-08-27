export const STRATEGY_TYPES = Object.freeze({
  SINGLE: "SINGLE",
  SPREAD: "SPREAD",
  GRID: "GRID",
  RANGE: "RANGE",
});

export const TRIGGER_DIRECTIONS = Object.freeze({
  RISE: "RISE",
  FALL: "FALL",
});

export const ACTIONS = Object.freeze({
  BUY: "BUY",
  SELL: "SELL",
  SELL_A_BUY_B: "SELL_A_BUY_B",
});

export const SINGLE_TRIGGER_MODES = Object.freeze({
  THRESHOLD_PCT: "THRESHOLD_PCT",
  TARGET_PRICE: "TARGET_PRICE",
});

export function normalizeSymbol(value) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

export function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function evaluateSingle(strategy, quote) {
  const referencePrice = Number(strategy.referencePrice);
  const currentPrice = Number(quote.price);
  const directionText = strategy.direction === TRIGGER_DIRECTIONS.FALL ? "下跌" : "上涨";
  const actionText = strategy.action === ACTIONS.BUY ? "买入" : "卖出";

  if (strategy.triggerMode === SINGLE_TRIGGER_MODES.TARGET_PRICE) {
    const targetPrice = Number(strategy.targetPrice);
    if (![referencePrice, currentPrice, targetPrice].every(Number.isFinite)
      || referencePrice <= 0 || currentPrice <= 0 || targetPrice <= 0) {
      throw new Error("单股目标价策略缺少有效的当前价格、目标价格或行情");
    }
    const targetRange = targetPrice - referencePrice;
    const distancePct = ((currentPrice - referencePrice) / Math.abs(targetRange)) * 100;
    const targetProgressPct = ((currentPrice - referencePrice) / targetRange) * 100;
    const triggered = strategy.direction === TRIGGER_DIRECTIONS.FALL
      ? currentPrice <= targetPrice
      : currentPrice >= targetPrice;
    const signedDistance = (distancePct > 0 ? "+" : "") + round(distancePct, 2);
    const targetText = targetPrice.toFixed(3).replace(/\.?0+$/, "");
    return {
      signal: triggered ? "TRIGGERED" : "WAITING",
      metricPct: round(distancePct),
      rawReturnPct: round(distancePct),
      thresholdPct: 100,
      targetProgressPct: round(targetProgressPct),
      targetPrice,
      prices: { [strategy.symbolA]: currentPrice },
      quoteNames: { [strategy.symbolA]: quote.name || strategy.symbolA },
      message: triggered
        ? strategy.symbolA + " 当前价 " + currentPrice + "，已达到" + directionText + "目标价 " + targetText + "，提示" + actionText
        : "当前价 " + currentPrice + " / 目标价 " + targetText + "（相对基准 " + signedDistance + "%）",
      refreshedAt: quote.timestamp || new Date().toISOString(),
    };
  }

  const thresholdPct = Math.abs(Number(strategy.thresholdPct));
  if (![referencePrice, currentPrice, thresholdPct].every(Number.isFinite) || referencePrice <= 0 || currentPrice <= 0) {
    throw new Error("单股策略缺少有效的价格或阈值");
  }

  const returnPct = ((currentPrice / referencePrice) - 1) * 100;
  const signedThresholdPct = strategy.direction === TRIGGER_DIRECTIONS.FALL ? -thresholdPct : thresholdPct;
  const triggered = strategy.direction === TRIGGER_DIRECTIONS.FALL
    ? returnPct <= signedThresholdPct
    : returnPct >= signedThresholdPct;

  const roundedReturn = round(returnPct, 2);
  const signedReturn = (roundedReturn > 0 ? "+" : "") + roundedReturn;
  const thresholdText = (signedThresholdPct > 0 ? "+" : "") + signedThresholdPct;

  return {
    signal: triggered ? "TRIGGERED" : "WAITING",
    metricPct: round(returnPct),
    rawReturnPct: round(returnPct),
    thresholdPct,
    prices: { [strategy.symbolA]: currentPrice },
    quoteNames: { [strategy.symbolA]: quote.name || strategy.symbolA },
    message: triggered
      ? strategy.symbolA + " 当前价差 " + signedReturn + "%：已达到" + directionText + "触发线 " + thresholdText + "%，提示" + actionText
      : "当前价差 " + signedReturn + "% / 触发线 " + thresholdText + "%",
    refreshedAt: quote.timestamp || new Date().toISOString(),
  };
}

export function evaluateSpread(strategy, quoteA, quoteB) {
  const basePriceA = Number(strategy.basePriceA);
  const basePriceB = Number(strategy.basePriceB);
  const currentPriceA = Number(quoteA.price);
  const currentPriceB = Number(quoteB.price);
  const thresholdPct = Math.abs(Number(strategy.thresholdPct));

  if (![basePriceA, basePriceB, currentPriceA, currentPriceB, thresholdPct].every(Number.isFinite)
    || basePriceA <= 0 || basePriceB <= 0 || currentPriceA <= 0 || currentPriceB <= 0) {
    throw new Error("价差策略缺少有效的基准价、当前价或阈值");
  }

  const returnA = currentPriceA / basePriceA;
  const returnB = currentPriceB / basePriceB;
  const relativeReturnPct = ((returnA / returnB) - 1) * 100;
  const triggered = relativeReturnPct >= thresholdPct;
  const timestamp = [quoteA.timestamp, quoteB.timestamp].filter(Boolean).sort().at(-1) || new Date().toISOString();

  return {
    signal: triggered ? "TRIGGERED" : "WAITING",
    metricPct: round(relativeReturnPct),
    thresholdPct,
    prices: {
      [strategy.symbolA]: currentPriceA,
      [strategy.symbolB]: currentPriceB,
    },
    quoteNames: {
      [strategy.symbolA]: quoteA.name || strategy.symbolA,
      [strategy.symbolB]: quoteB.name || strategy.symbolB,
    },
    message: triggered
      ? `${strategy.symbolA} 相对 ${strategy.symbolB} 超额 ${round(relativeReturnPct, 2)}%，提示卖 A 买 B`
      : `相对收益 ${round(relativeReturnPct, 2)}% / 目标 ${thresholdPct}%`,
    refreshedAt: timestamp,
  };
}

export function evaluateGrid(strategy, quote, previousEvaluation = null) {
  const lowerPrice = Number(strategy.lowerPrice);
  const upperPrice = Number(strategy.upperPrice);
  const gridCount = Number(strategy.gridCount);
  const currentPrice = Number(quote.price);
  if (![lowerPrice, upperPrice, gridCount, currentPrice].every(Number.isFinite)
    || lowerPrice <= 0 || upperPrice <= lowerPrice || !Number.isInteger(gridCount)
    || gridCount < 2 || gridCount > 200 || currentPrice <= 0) {
    throw new Error("网格策略缺少有效的价格区间、网格数量或行情");
  }

  const stepPrice = (upperPrice - lowerPrice) / gridCount;
  const gridIndex = Math.max(0, Math.min(gridCount, Math.floor((currentPrice - lowerPrice) / stepPrice)));
  const previousIndex = Number(previousEvaluation?.gridIndex);
  const hasPrevious = Number.isInteger(previousIndex);
  const crossedCount = hasPrevious ? Math.abs(gridIndex - previousIndex) : 0;
  const action = crossedCount === 0 ? null : gridIndex > previousIndex ? ACTIONS.SELL : ACTIONS.BUY;
  const gridPrice = action === ACTIONS.SELL
    ? lowerPrice + gridIndex * stepPrice
    : action === ACTIONS.BUY
      ? lowerPrice + previousIndex * stepPrice
      : lowerPrice + gridIndex * stepPrice;
  const positionPct = ((currentPrice - lowerPrice) / (upperPrice - lowerPrice)) * 100;
  const actionText = action === ACTIONS.SELL ? "卖出" : "买入";
  const rangeText = `${round(lowerPrice, 3)}–${round(upperPrice, 3)}`;
  const outsideRange = currentPrice < lowerPrice ? "，已低于网格下限" : currentPrice > upperPrice ? "，已高于网格上限" : "";

  return {
    signal: crossedCount > 0 ? "TRIGGERED" : "WAITING",
    metricPct: round(positionPct),
    thresholdPct: null,
    action,
    gridIndex,
    previousGridIndex: hasPrevious ? previousIndex : null,
    crossedCount,
    gridPrice: round(gridPrice),
    stepPrice: round(stepPrice),
    prices: { [strategy.symbolA]: currentPrice },
    quoteNames: { [strategy.symbolA]: quote.name || strategy.symbolA },
    message: crossedCount > 0
      ? `${strategy.symbolA} 当前价 ${currentPrice}，${actionText}信号：跨越 ${crossedCount} 档，参考网格价 ${round(gridPrice, 3)}${outsideRange}`
      : `当前位于第 ${gridIndex}/${gridCount} 档 · 区间 ${rangeText}${outsideRange}`,
    refreshedAt: quote.timestamp || new Date().toISOString(),
  };
}

export function evaluateRange(strategy, quote) {
  const lowerPrice = Number(strategy.lowerPrice);
  const upperPrice = Number(strategy.upperPrice);
  const currentPrice = Number(quote.price);
  if (![lowerPrice, upperPrice, currentPrice].every(Number.isFinite)
    || lowerPrice <= 0 || upperPrice <= lowerPrice || currentPrice <= 0) {
    throw new Error("区间策略缺少有效的上下边界或行情");
  }

  const action = currentPrice <= lowerPrice ? ACTIONS.BUY : currentPrice >= upperPrice ? ACTIONS.SELL : null;
  const positionPct = ((currentPrice - lowerPrice) / (upperPrice - lowerPrice)) * 100;
  const boundaryPrice = action === ACTIONS.BUY ? lowerPrice : action === ACTIONS.SELL ? upperPrice : null;
  const statusText = action === ACTIONS.BUY ? "已达到买入下限" : action === ACTIONS.SELL ? "已达到卖出上限" : "位于交易区间内";
  return {
    signal: action ? "TRIGGERED" : "WAITING",
    metricPct: round(positionPct),
    thresholdPct: null,
    action,
    boundaryPrice,
    rangeStatus: action === ACTIONS.BUY ? "BELOW" : action === ACTIONS.SELL ? "ABOVE" : "INSIDE",
    prices: { [strategy.symbolA]: currentPrice },
    quoteNames: { [strategy.symbolA]: quote.name || strategy.symbolA },
    message: strategy.symbolA + " 当前价 " + currentPrice + "，" + statusText + "（买入 " + round(lowerPrice, 3) + " / 卖出 " + round(upperPrice, 3) + "）",
    refreshedAt: quote.timestamp || new Date().toISOString(),
  };
}

export function validateStrategyInput(input, partial = false) {
  const errors = [];
  const type = input.type;

  if (!partial || type !== undefined) {
    if (![STRATEGY_TYPES.SINGLE, STRATEGY_TYPES.SPREAD, STRATEGY_TYPES.GRID, STRATEGY_TYPES.RANGE].includes(type)) errors.push("策略类型无效");
  }
  if (!partial || input.name !== undefined) {
    if (!String(input.name ?? "").trim()) errors.push("策略名称不能为空");
  }
  if (!partial || input.symbolA !== undefined) {
    if (!normalizeSymbol(input.symbolA)) errors.push("股票代码 A 不能为空");
  }
  const targetPriceMode = type === STRATEGY_TYPES.SINGLE && input.triggerMode === SINGLE_TRIGGER_MODES.TARGET_PRICE;
  if (![STRATEGY_TYPES.GRID, STRATEGY_TYPES.RANGE].includes(type) && !targetPriceMode && (!partial || input.thresholdPct !== undefined)) {
    const threshold = Number(input.thresholdPct);
    if (!Number.isFinite(threshold) || threshold <= 0) errors.push("阈值必须是大于 0 的数字");
  }
  if (type === STRATEGY_TYPES.SINGLE) {
    if (!partial || input.referencePrice !== undefined) {
      const price = Number(input.referencePrice);
      if (!Number.isFinite(price) || price <= 0) errors.push(targetPriceMode ? "当前价格必须是大于 0 的数字" : "基准价必须是大于 0 的数字");
    }
    if (targetPriceMode && (!partial || input.targetPrice !== undefined)) {
      const targetPrice = Number(input.targetPrice);
      if (!Number.isFinite(targetPrice) || targetPrice <= 0) errors.push("目标价格必须是大于 0 的数字");
      else if (input.direction === TRIGGER_DIRECTIONS.RISE && targetPrice <= Number(input.referencePrice)) errors.push("上涨目标价必须高于当前价格");
      else if (input.direction === TRIGGER_DIRECTIONS.FALL && targetPrice >= Number(input.referencePrice)) errors.push("下跌目标价必须低于当前价格");
    }
    if (!partial || input.direction !== undefined) {
      if (![TRIGGER_DIRECTIONS.RISE, TRIGGER_DIRECTIONS.FALL].includes(input.direction)) errors.push("触发方向无效");
    }
    if (!partial || input.action !== undefined) {
      if (![ACTIONS.BUY, ACTIONS.SELL].includes(input.action)) errors.push("提示动作无效");
    }
  }
  if (type === STRATEGY_TYPES.SPREAD) {
    if (!normalizeSymbol(input.symbolB)) errors.push("股票代码 B 不能为空");
    const hasBaseA = input.basePriceA !== null && input.basePriceA !== undefined && input.basePriceA !== "";
    const hasBaseB = input.basePriceB !== null && input.basePriceB !== undefined && input.basePriceB !== "";
    if (hasBaseA !== hasBaseB) errors.push("A、B 基准价必须同时填写或同时留空");
    if (hasBaseA && (!Number.isFinite(Number(input.basePriceA)) || Number(input.basePriceA) <= 0)) errors.push("A 基准价必须大于 0");
    if (hasBaseB && (!Number.isFinite(Number(input.basePriceB)) || Number(input.basePriceB) <= 0)) errors.push("B 基准价必须大于 0");
    if (normalizeSymbol(input.symbolA) === normalizeSymbol(input.symbolB)) errors.push("A、B 股票代码不能相同");
  }

  if (type === STRATEGY_TYPES.GRID) {
    const lowerPrice = Number(input.lowerPrice);
    const upperPrice = Number(input.upperPrice);
    const gridCount = Number(input.gridCount);
    if (!Number.isFinite(lowerPrice) || lowerPrice <= 0) errors.push("网格下限必须是大于 0 的数字");
    if (!Number.isFinite(upperPrice) || upperPrice <= 0) errors.push("网格上限必须是大于 0 的数字");
    if (Number.isFinite(lowerPrice) && Number.isFinite(upperPrice) && upperPrice <= lowerPrice) errors.push("网格上限必须高于下限");
    if (!Number.isInteger(gridCount) || gridCount < 2 || gridCount > 200) errors.push("网格数量必须是 2 到 200 之间的整数");
  }

  if (type === STRATEGY_TYPES.RANGE) {
    const lowerPrice = Number(input.lowerPrice);
    const upperPrice = Number(input.upperPrice);
    if (!Number.isFinite(lowerPrice) || lowerPrice <= 0) errors.push("买入下限必须是大于 0 的数字");
    if (!Number.isFinite(upperPrice) || upperPrice <= 0) errors.push("卖出上限必须是大于 0 的数字");
    if (Number.isFinite(lowerPrice) && Number.isFinite(upperPrice) && upperPrice <= lowerPrice) errors.push("卖出上限必须高于买入下限");
  }

  return errors;
}
