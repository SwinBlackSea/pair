const state = {
  strategies: [],
  triggerHistory: [],
  system: null,
  filter: "ALL",
  editingId: null,
  executingEventId: null,
};

const elements = {
  grid: document.querySelector("#strategyGrid"),
  empty: document.querySelector("#emptyState"),
  template: document.querySelector("#strategyCardTemplate"),
  dialog: document.querySelector("#strategyDialog"),
  form: document.querySelector("#strategyForm"),
  typeSwitch: document.querySelector("#typeSwitch"),
  saveButton: document.querySelector("#saveButton"),
  refreshAllButton: document.querySelector("#refreshAllButton"),
  historyGrid: document.querySelector("#historyGrid"),
  historyTemplate: document.querySelector("#historyRowTemplate"),
  executionDialog: document.querySelector("#executionDialog"),
  executionForm: document.querySelector("#executionForm"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers,
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

function formatTime(value, includeDate = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: includeDate ? "2-digit" : undefined,
    day: includeDate ? "2-digit" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    second: includeDate ? undefined : "2-digit",
    hour12: false,
  }).format(date);
}



const symbolPickerStates = new WeakMap();

function closeSymbolSuggestions(input) {
  const suggestions = input.closest("[data-symbol-picker]")?.querySelector(".symbol-suggestions");
  if (!suggestions) return;
  suggestions.hidden = true;
  suggestions.replaceChildren();
  input.removeAttribute("aria-activedescendant");
}

function setSymbolHint(input, message = null) {
  const picker = input.closest("[data-symbol-picker]");
  const hint = picker?.parentElement?.querySelector(".symbol-hint");
  if (hint) hint.textContent = message || "支持中文名称、拼音或代码；请选择联想结果";
}

function renderSymbolSuggestions(input, items) {
  const picker = input.closest("[data-symbol-picker]");
  const suggestions = picker?.querySelector(".symbol-suggestions");
  const pickerState = symbolPickerStates.get(input);
  if (!suggestions || !pickerState) return;
  suggestions.replaceChildren();
  pickerState.items = items;

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "symbol-empty";
    empty.textContent = "未找到匹配标的";
    suggestions.append(empty);
    suggestions.hidden = false;
    return;
  }

  items.forEach((item, index) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "symbol-option";
    option.id = suggestions.id + "-option-" + index;
    option.setAttribute("role", "option");
    option.innerHTML = "<span class=\"symbol-option-main\"><b></b><small></small></span><span class=\"symbol-option-market\"></span>";
    option.querySelector("b").textContent = item.name;
    option.querySelector("small").textContent = item.symbol;
    option.querySelector(".symbol-option-market").textContent = item.market;
    option.title = item.name + " · " + item.symbol + (item.market ? " · " + item.market : "");
    option.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      input.value = item.symbol;
      input.dataset.selectedSymbol = item.symbol;
      input.setCustomValidity("");
      setSymbolHint(input, "已选择：" + item.name + " · " + item.symbol);
      closeSymbolSuggestions(input);
      fillSelectedSymbolPrice(input, item);
    });
    suggestions.append(option);
  });
  pickerState.items = items;
  pickerState.activeIndex = -1;
  suggestions.hidden = false;
}

async function searchSymbols(input, query) {
  const pickerState = symbolPickerStates.get(input);
  if (!pickerState) return;
  pickerState.requestId += 1;
  const requestId = pickerState.requestId;
  pickerState.controller?.abort();
  pickerState.controller = new AbortController();

  try {
    const response = await fetch("/api/symbols/search?q=" + encodeURIComponent(query), {
      signal: pickerState.controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "标的搜索失败");
    if (requestId !== pickerState.requestId || input.value.trim() !== query) return;
    renderSymbolSuggestions(input, payload.items || []);
  } catch (error) {
    if (error.name === "AbortError" || requestId !== pickerState.requestId) return;
    closeSymbolSuggestions(input);
    setSymbolHint(input, "搜索服务暂不可用，可直接输入股票代码");
  }
}

function setupSymbolPicker(input) {
  const pickerState = { timer: null, controller: null, requestId: 0, items: [], activeIndex: -1 };
  symbolPickerStates.set(input, pickerState);
  input.addEventListener("input", () => {
    delete input.dataset.selectedSymbol;
    input.setCustomValidity("");
    setSymbolHint(input);
    clearTimeout(pickerState.timer);
    pickerState.controller?.abort();
    const query = input.value.trim();
    if (!query) {
      closeSymbolSuggestions(input);
      return;
    }
    pickerState.timer = setTimeout(() => searchSymbols(input, query), 180);
  });
  input.addEventListener("keydown", (event) => {
    const suggestions = input.closest("[data-symbol-picker]")?.querySelector(".symbol-suggestions");
    if (!suggestions || suggestions.hidden || !pickerState.items.length) {
      if (event.key === "Enter" && /[\u3400-\u9fff]/.test(input.value)) event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      pickerState.activeIndex = (pickerState.activeIndex + (event.key === "ArrowDown" ? 1 : -1) + pickerState.items.length) % pickerState.items.length;
      suggestions.querySelectorAll(".symbol-option").forEach((option, index) => {
        const active = index === pickerState.activeIndex;
        option.classList.toggle("active", active);
        option.setAttribute("aria-selected", String(active));
      });
      input.setAttribute("aria-activedescendant", suggestions.id + "-option-" + pickerState.activeIndex);
    } else if (event.key === "Enter" && pickerState.activeIndex >= 0) {
      event.preventDefault();
      suggestions.querySelectorAll(".symbol-option")[pickerState.activeIndex]?.dispatchEvent(new PointerEvent("pointerdown"));
    } else if (event.key === "Escape") {
      closeSymbolSuggestions(input);
    }
  });
  input.addEventListener("blur", () => setTimeout(() => closeSymbolSuggestions(input), 120));
}

function resetSymbolPickers() {
  document.querySelectorAll("[data-symbol-picker] input").forEach((input) => {
    delete input.dataset.selectedSymbol;
    input.setCustomValidity("");
    setSymbolHint(input);
    closeSymbolSuggestions(input);
  });
}

function priceFieldForSymbolInput(input) {
  const type = new FormData(elements.form).get("type");
  if (type === "GRID") return null;
  const isSpread = type === "SPREAD";
  if (!isSpread) return elements.form.elements.referencePrice;
  return input.name === "symbolA" ? elements.form.elements.basePriceA : elements.form.elements.basePriceB;
}

async function fillSelectedSymbolPrice(input, item) {
  const pickerState = symbolPickerStates.get(input);
  if (!pickerState) return;
  pickerState.quoteRequestId = (pickerState.quoteRequestId || 0) + 1;
  const requestId = pickerState.quoteRequestId;
  pickerState.quoteController?.abort();
  pickerState.quoteController = new AbortController();
  setSymbolHint(input, "已选择：" + item.name + " · 正在获取最新价…");

  try {
    const response = await fetch("/api/quotes?symbol=" + encodeURIComponent(item.symbol), {
      signal: pickerState.quoteController.signal,
    });
    const quote = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(quote.error || "行情获取失败");
    if (requestId !== pickerState.quoteRequestId || input.dataset.selectedSymbol !== item.symbol) return;
    const price = Number(quote.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error("行情未返回有效当前价");

    const field = priceFieldForSymbolInput(input);
    if (field) field.value = String(price);
    setSymbolHint(input, "已选择：" + (quote.name || item.name) + " · 当前价 ¥" + formatPrice(price) + (field ? "，已自动填入" : ""));
  } catch (error) {
    if (error.name === "AbortError" || requestId !== pickerState.quoteRequestId) return;
    setSymbolHint(input, "已选择：" + item.name + " · 最新价获取失败，可手动填写");
  }
}

function validateSymbolInputs() {
  let valid = true;
  document.querySelectorAll("[data-symbol-picker] input").forEach((input) => {
    const hasChinese = /[\u3400-\u9fff]/.test(input.value);
    input.setCustomValidity(hasChinese ? "请从联想列表中选择一个标的" : "");
    valid = valid && !hasChinese;
  });
  return valid;
}
function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  const region = elements.executionDialog.open
    ? document.querySelector("#executionToastRegion")
    : elements.dialog.open
      ? document.querySelector("#dialogToastRegion")
      : document.querySelector("#toastRegion");
  region.append(toast);
  setTimeout(() => toast.remove(), 3_600);
}

function strategyMatches(strategy) {
  if (state.filter === "ALL") return !strategy.deletedAt;
  if (state.filter === "TRASH") return Boolean(strategy.deletedAt);
  return !strategy.deletedAt && strategy.type === state.filter;
}

function formatPrice(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}

function makePriceChip(symbol, price, baseline, name, leg = null) {
  const chip = document.createElement("div");
  chip.className = "price-chip";
  const label = document.createElement("span");
  label.textContent = leg ? leg + " · " + symbol : symbol;
  label.title = (name || symbol) + (name && name !== symbol ? " · " + symbol : "");
  const value = document.createElement("b");
  value.textContent = baseline == null
    ? formatPrice(price)
    : `现 ${formatPrice(price)} · 基 ${formatPrice(baseline)}`;
  chip.append(value, label);
  return chip;
}

function makeRelationText(strategy, names) {
  const nameA = names[strategy.symbolA] || strategy.symbolA;
  if (strategy.type === "SPREAD") {
    const nameB = names[strategy.symbolB] || strategy.symbolB;
    return `持有 ${nameA}  →  期望 ${nameB}`;
  }
  if (strategy.type === "GRID") return `${nameA} · ${formatPrice(strategy.lowerPrice)}–${formatPrice(strategy.upperPrice)} · ${strategy.gridCount} 格`;
  if (strategy.type === "RANGE") return `${nameA} · 买入 ${formatPrice(strategy.lowerPrice)} · 卖出 ${formatPrice(strategy.upperPrice)}`;
  const direction = strategy.direction === "FALL" ? "下跌" : "上涨";
  const action = strategy.action === "BUY" ? "买入" : "卖出";
  return `${nameA}，${direction}${action}`;
}

function shortStrategyId(id) {
  return String(id || "").slice(0, 8);
}

function linkedStrategy(record) {
  return state.strategies.find((strategy) => strategy.id === record.strategyId) || null;
}

function strategyTypeName(type) {
  return type === "SPREAD" ? "A/B 相对收益" : type === "GRID" ? "网格交易" : type === "RANGE" ? "区间交易" : "单股价格";
}

function renderCard(strategy, index) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector(".strategy-card");
  const evaluation = strategy.lastEvaluation || {};
  const triggered = evaluation.signal === "TRIGGERED";
  const errored = evaluation.signal === "ERROR";
  const deleted = Boolean(strategy.deletedAt);
  card.dataset.id = strategy.id;
  card.style.animationDelay = `${Math.min(index * 45, 250)}ms`;
  card.classList.toggle("triggered", triggered);
  card.classList.toggle("paused", !strategy.enabled);
  card.classList.toggle("deleted", deleted);
  card.classList.toggle("grid-strategy", strategy.type === "GRID");
  card.classList.toggle("range-strategy", strategy.type === "RANGE");

  const names = evaluation.quoteNames || {};
  const prices = evaluation.prices || {};

  fragment.querySelector(".type-badge").textContent = strategyTypeName(strategy.type);
  const triggerCount = state.triggerHistory.filter((record) => record.strategyId === strategy.id).length;
  const triggerCountBadge = fragment.querySelector(".trigger-count-badge");
  triggerCountBadge.textContent = triggerCount > 99 ? "99+" : String(triggerCount);
  triggerCountBadge.hidden = triggerCount === 0;
  triggerCountBadge.title = "累计触发 " + triggerCount + " 次";
  triggerCountBadge.setAttribute("aria-label", triggerCountBadge.title);
  const stateBadge = fragment.querySelector(".state-badge");
  stateBadge.textContent = deleted ? "已删除" : !strategy.enabled ? "已暂停" : errored ? "行情异常" : triggered ? "需要行动" : "观察中";
  fragment.querySelector("h3").textContent = strategy.name;
  fragment.querySelector("h3").title = strategy.name + "\n策略完整 ID：" + strategy.id;
  fragment.querySelector(".symbol-line").textContent = makeRelationText(strategy, names);
  fragment.querySelector(".symbol-line").title = fragment.querySelector(".symbol-line").textContent;
  const notes = String(strategy.notes || "").trim();
  const notesElement = fragment.querySelector(".strategy-notes");
  notesElement.textContent = notes ? "备注：" + notes : "";
  notesElement.title = notes;
  notesElement.hidden = !notes;

  const targetMode = strategy.type === "SINGLE" && strategy.triggerMode === "TARGET_PRICE";
  const gridMode = strategy.type === "GRID";
  const rangeMode = strategy.type === "RANGE";
  fragment.querySelector(".metric-label").textContent = strategy.type === "SPREAD" ? "A 相对 B 价差" : (gridMode || rangeMode) ? "区间位置" : targetMode ? "相对基准目标价差" : "相对基准价差";
  const metric = Number(evaluation.metricPct);
  const metricValue = fragment.querySelector(".metric-value");
  metricValue.textContent = gridMode && Number.isInteger(Number(evaluation.gridIndex))
    ? "第 " + evaluation.gridIndex + " / " + strategy.gridCount + " 档"
    : rangeMode
      ? evaluation.rangeStatus === "BELOW" ? "买入触发" : evaluation.rangeStatus === "ABOVE" ? "卖出触发" : "区间内"
      : Number.isFinite(metric) ? (metric > 0 ? "+" : "") + metric.toFixed(2) + "%" : "—";
  if (rangeMode) {
    fragment.querySelector(".metric-label").textContent = Number.isFinite(metric) ? "区间位置 " + metric.toFixed(0) + "%" : "区间位置";
    const thresholdValue = fragment.querySelector(".threshold-value");
    thresholdValue.textContent = "买 " + formatPrice(strategy.lowerPrice) + " · 卖 " + formatPrice(strategy.upperPrice);
    thresholdValue.title = "达到下限提示买入，达到上限提示卖出";
  } else if (gridMode) {
    fragment.querySelector(".metric-label").textContent = Number.isFinite(metric) ? "区间位置 " + metric.toFixed(0) + "%" : "区间位置";
    const gridIndex = Number(evaluation.gridIndex);
    const stepPrice = Number(evaluation.stepPrice);
    const nextBuy = Number.isInteger(gridIndex) && gridIndex > 0 ? Number(strategy.lowerPrice) + gridIndex * stepPrice : null;
    const nextSell = Number.isInteger(gridIndex) && gridIndex < Number(strategy.gridCount) ? Number(strategy.lowerPrice) + (gridIndex + 1) * stepPrice : null;
    const nextLevels = [
      nextBuy == null ? null : "买 " + formatPrice(nextBuy),
      nextSell == null ? null : "卖 " + formatPrice(nextSell),
    ].filter(Boolean);
    const thresholdValue = fragment.querySelector(".threshold-value");
    thresholdValue.textContent = nextLevels.join(" · ") || "区间外";
    thresholdValue.title = "每格 " + formatPrice(stepPrice) + " · 区间 " + formatPrice(strategy.lowerPrice) + "–" + formatPrice(strategy.upperPrice);
  } else if (targetMode) {
    fragment.querySelector(".threshold-value").textContent = "目标 " + formatPrice(strategy.targetPrice);
  } else {
    const threshold = Number(strategy.thresholdPct) * (strategy.type === "SINGLE" && strategy.direction === "FALL" ? -1 : 1);
    fragment.querySelector(".threshold-value").textContent = (threshold > 0 ? "+" : "") + threshold.toFixed(2) + "%";
  }
  const directedMetric = strategy.type === "SINGLE" && strategy.direction === "FALL" ? -metric : metric;
  const targetProgress = Number(evaluation.targetProgressPct);
  const progress = (gridMode || rangeMode)
    ? (Number.isFinite(metric) ? Math.min(100, Math.max(0, metric)) : 0)
    : targetMode
    ? (Number.isFinite(targetProgress) ? Math.min(100, Math.max(0, targetProgress)) : 0)
    : Number.isFinite(directedMetric) && Number(strategy.thresholdPct) > 0
      ? Math.min(100, Math.max(0, directedMetric / Number(strategy.thresholdPct) * 100))
      : 0;
  fragment.querySelector(".progress-track i").style.width = progress + "%";
  const signalMessage = fragment.querySelector(".signal-message");
  signalMessage.textContent = evaluation.message || "等待首次行情刷新";
  signalMessage.title = signalMessage.textContent;
  signalMessage.hidden = !triggered && !errored;

  const priceRow = fragment.querySelector(".price-row");
  priceRow.append(makePriceChip(
    strategy.symbolA,
    prices[strategy.symbolA],
    strategy.type === "SPREAD" ? strategy.basePriceA : strategy.referencePrice,
    names[strategy.symbolA],
    strategy.type === "SPREAD" ? "A" : null,
  ));
  if (strategy.type === "SPREAD") {
    priceRow.append(makePriceChip(strategy.symbolB, prices[strategy.symbolB], strategy.basePriceB, names[strategy.symbolB], "B"));
  }

  const refreshedTime = fragment.querySelector(".refreshed-time");
  refreshedTime.textContent = "ID " + shortStrategyId(strategy.id) + " · 更新 " + formatTime(evaluation.refreshedAt, true);
  refreshedTime.title = "策略完整 ID：" + strategy.id;
  const refreshButton = fragment.querySelector(".refresh-one");
  const editButton = fragment.querySelector('[data-action="edit"]');
  const toggleButton = fragment.querySelector('[data-action="toggle"]');
  const deleteButton = fragment.querySelector('[data-action="delete"]');
  refreshButton.hidden = deleted;
  editButton.hidden = deleted;
  toggleButton.hidden = deleted;
  toggleButton.textContent = strategy.enabled ? "暂停监控" : "恢复监控";
  deleteButton.textContent = deleted ? "恢复策略" : "移至回收站";
  deleteButton.dataset.action = deleted ? "restore" : "delete";
  deleteButton.classList.toggle("danger", !deleted);

  const menuButton = fragment.querySelector(".menu-button");
  const menu = fragment.querySelector(".card-menu");
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    document.querySelectorAll(".card-menu").forEach((other) => { if (other !== menu) other.hidden = true; });
    menu.hidden = !menu.hidden;
  });
  menu.addEventListener("click", (event) => handleCardAction(event, strategy));
  refreshButton.addEventListener("click", (event) => refreshOne(event.currentTarget, strategy.id));
  return fragment;
}

function instrumentNameForRecord(record, symbol) {
  return record.quoteNames?.[symbol] || symbol;
}

function executionLegsForEvent(record) {
  if (record.strategyType === "SPREAD") {
    return [
      { symbol: record.symbolA, side: "SELL", label: "卖出 " + instrumentNameForRecord(record, record.symbolA) },
      { symbol: record.symbolB, side: "BUY", label: "买入 " + instrumentNameForRecord(record, record.symbolB) },
    ];
  }
  return [{
    symbol: record.symbolA,
    side: record.action === "BUY" ? "BUY" : "SELL",
    label: record.action === "BUY" ? "买入" : "卖出",
  }];
}

function currencyForSymbol(symbol) {
  const text = String(symbol);
  const isFiveDigits = text.length === 5 && Array.from(text).every((char) => char >= "0" && char <= "9");
  return text.startsWith("HK") || isFiveDigits ? "HKD" : "CNY";
}

function formatSignedNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return (number > 0 ? "+" : "") + number.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function replaceHistoryRecord(updated) {
  const index = state.triggerHistory.findIndex((item) => item.id === updated.id);
  if (index >= 0) state.triggerHistory[index] = updated;
}

async function setHistoryStatus(record, status, button) {
  if (status === "EXECUTED") return openExecutionDialog(record);
  button.disabled = true;
  try {
    const updated = await api("/api/trigger-history/" + record.id, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    replaceHistoryRecord(updated);
    render();
    showToast(status === "SKIPPED" ? "已标记为不执行" : "已恢复为未执行");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function renderHistoryRow(record) {
  const fragment = elements.historyTemplate.content.cloneNode(true);
  const row = fragment.querySelector(".history-row");
  row.classList.add("history-" + String(record.status || "PENDING").toLowerCase());
  fragment.querySelector(".history-time").textContent = formatTime(record.triggeredAt, true);
  const currentStrategy = linkedStrategy(record);
  const currentName = currentStrategy?.name || record.strategyName;
  const historyName = fragment.querySelector(".history-primary b");
  const historyMeta = fragment.querySelector(".history-primary small");
  historyName.textContent = currentName;
  historyName.title = "策略完整 ID：" + record.strategyId + (currentName !== record.strategyName ? "\n触发时名称：" + record.strategyName : "");
  const typeName = strategyTypeName(record.strategyType);
  historyMeta.textContent = "ID " + shortStrategyId(record.strategyId) + " · " + (currentName !== record.strategyName ? "触发时：" + record.strategyName : typeName);
  historyMeta.title = historyName.title;
  const snapshotMessage = fragment.querySelector(".history-signal p");
  const snapshotPrices = fragment.querySelector(".history-signal small");
  snapshotMessage.textContent = record.message;
  snapshotPrices.textContent = Object.entries(record.triggerPrices || {}).map(([symbol, price]) => symbol + " " + formatPrice(price)).join(" · ");
  snapshotMessage.title = snapshotMessage.textContent;
  snapshotPrices.title = snapshotPrices.textContent;

  const statusNames = { PENDING: "未执行", EXECUTED: "已执行", SKIPPED: "已结束 · 不执行" };
  const status = record.status || "PENDING";
  const statusElement = fragment.querySelector(".history-status");
  statusElement.textContent = statusNames[status];
  statusElement.classList.add("status-" + status.toLowerCase());

  const result = fragment.querySelector(".history-result");
  const details = fragment.querySelector(".history-details");
  const historicalResult = record.historicalResult;
  if (status !== "EXECUTED" || !historicalResult) {
    result.textContent = "—";
    details.textContent = "—";
  } else {
    if (Number.isFinite(Number(historicalResult.relativeReturnPct))) {
      const summary = document.createElement("span");
      summary.classList.add("history-summary");
      summary.textContent = "历史相对收益 " + formatSignedNumber(historicalResult.relativeReturnPct) + "%";
      summary.classList.toggle("positive", Number(historicalResult.relativeReturnPct) > 0);
      summary.classList.toggle("negative", Number(historicalResult.relativeReturnPct) < 0);
      result.append(summary);

      if (record.strategyType === "SPREAD") {
        const sellLeg = historicalResult.legs?.find((leg) => leg.symbol === record.symbolA && leg.side === "SELL");
        const buyLeg = historicalResult.legs?.find((leg) => leg.symbol === record.symbolB && leg.side === "BUY");
        if (sellLeg?.baselinePrice > 0 && buyLeg?.baselinePrice > 0) {
          const formula = document.createElement("span");
          formula.className = "history-formula";
          formula.textContent = "(" + formatPrice(sellLeg.price) + " ÷ " + formatPrice(sellLeg.baselinePrice) + ") ÷ (" + formatPrice(buyLeg.price) + " ÷ " + formatPrice(buyLeg.baselinePrice) + ") − 1";
          result.append(formula);
        }
      }
    }
    if (Number.isFinite(Number(historicalResult.totalPnlCny))) {
      const total = document.createElement("span");
      total.className = "history-total";
      total.textContent = "折合总收益 " + formatSignedNumber(historicalResult.totalPnlCny) + " CNY";
      total.classList.toggle("positive", Number(historicalResult.totalPnlCny) > 0);
      total.classList.toggle("negative", Number(historicalResult.totalPnlCny) < 0);
      result.append(total);
      if (historicalResult.fx?.rate > 0) {
        const fx = document.createElement("span");
        fx.className = "history-fx";
        fx.textContent = "1 HKD = " + Number(historicalResult.fx.rate).toFixed(6) + " CNY · " + (historicalResult.fx.asOf || "手动汇率");
        result.append(fx);
      }
    }
    (historicalResult.legs || []).forEach((leg) => {
      if (!Number.isFinite(Number(leg.returnPct)) || !Number.isFinite(Number(leg.pnl))) return;
      const line = document.createElement("span");
      const action = leg.side === "BUY" ? "买入" : "卖出";
      line.textContent = action + " " + instrumentNameForRecord(record, leg.symbol) + " " + formatSignedNumber(leg.returnPct) + "%";
      line.classList.toggle("positive", Number(leg.pnl) > 0);
      line.classList.toggle("negative", Number(leg.pnl) < 0);
      details.append(line);
      if (Number.isFinite(Number(leg.baselinePrice)) && Number(leg.baselinePrice) > 0) {
        const prices = document.createElement("span");
        prices.className = "history-leg-prices";
        const quantity = Number(leg.quantity).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
        const difference = leg.side === "BUY"
          ? "基 " + formatPrice(leg.baselinePrice) + " − 执 " + formatPrice(leg.price)
          : "执 " + formatPrice(leg.price) + " − 基 " + formatPrice(leg.baselinePrice);
        prices.textContent = "(" + difference + ") × 数量 " + quantity + " = " + formatSignedNumber(leg.pnl) + " " + currencyForSymbol(leg.symbol);
        details.append(prices);
      }
    });
  }

  fragment.querySelectorAll(".history-primary b, .history-primary small, .history-signal p, .history-signal small, .history-result span, .history-details span").forEach((element) => {
    if (!element.title) element.title = element.textContent;
  });

  fragment.querySelectorAll("[data-history-action]").forEach((button) => {
    button.classList.toggle("active", button.dataset.historyAction === status);
    button.addEventListener("click", () => setHistoryStatus(record, button.dataset.historyAction, button));
  });
  return fragment;
}

async function openExecutionDialog(record) {
  state.executingEventId = record.id;
  elements.executionForm.reset();
  const summary = document.querySelector("#executionSummary");
  summary.replaceChildren();
  const title = document.createElement("b");
  title.textContent = linkedStrategy(record)?.name || record.strategyName;
  title.title = title.textContent + "\n策略完整 ID：" + record.strategyId;
  const detail = document.createElement("small");
  detail.textContent = formatTime(record.triggeredAt, true) + " · " + record.message;
  detail.title = detail.textContent;
  summary.append(title, detail);

  const legsContainer = document.querySelector("#executionLegs");
  legsContainer.replaceChildren();
  const expectedLegs = executionLegsForEvent(record);
  expectedLegs.forEach((expected) => {
    const saved = record.execution?.legs?.find((leg) => leg.symbol === expected.symbol && leg.side === expected.side);
    const leg = document.createElement("section");
    leg.className = "execution-leg";
    leg.dataset.symbol = expected.symbol;
    leg.dataset.side = expected.side;
    const heading = document.createElement("div");
    heading.innerHTML = "<b></b><small></small>";
    heading.querySelector("b").textContent = expected.label + " · " + expected.symbol;
    heading.querySelector("small").textContent = "触发价 " + formatPrice(record.triggerPrices?.[expected.symbol]);
    heading.querySelector("b").title = heading.querySelector("b").textContent;
    heading.querySelector("small").title = heading.querySelector("small").textContent;

    const fields = document.createElement("div");
    fields.className = "execution-fields";
    const priceField = document.createElement("label");
    priceField.className = "field";
    priceField.innerHTML = "<span>执行价格</span><input class=\"execution-price\" type=\"number\" min=\"0.001\" step=\"0.001\" required>";
    priceField.querySelector("input").value = saved?.price ?? record.triggerPrices?.[expected.symbol] ?? "";
    const quantityField = document.createElement("label");
    quantityField.className = "field";
    quantityField.innerHTML = "<span>执行数量</span><input class=\"execution-quantity\" type=\"number\" min=\"0.001\" step=\"0.001\" required>";
    quantityField.querySelector("input").value = saved?.quantity ?? "";
    fields.append(priceField, quantityField);
    leg.append(heading, fields);
    legsContainer.append(leg);
  });
  const fxField = document.querySelector("#executionFxField");
  const fxInput = document.querySelector("#executionFxRate");
  const fxHint = document.querySelector("#executionFxHint");
  const currencies = new Set(expectedLegs.map((leg) => currencyForSymbol(leg.symbol)));
  const needsFx = currencies.has("HKD") && currencies.has("CNY");
  fxField.hidden = !needsFx;
  fxInput.required = needsFx;
  fxInput.value = record.execution?.fx?.rate ?? "";
  fxInput.dataset.asOf = record.execution?.fx?.asOf || "";
  fxInput.dataset.source = record.execution?.fx?.source || "手动";
  fxInput.oninput = () => {
    fxInput.dataset.source = "手动";
    fxInput.dataset.asOf = new Date().toISOString().slice(0, 10);
    fxHint.textContent = "手动汇率 · 将随执行记录锁定";
  };
  fxHint.textContent = record.execution?.fx?.rate ? "已锁定汇率 · " + (record.execution.fx.asOf || "手动") : "正在获取 ECB 参考汇率…";
  elements.executionDialog.showModal();
  if (needsFx && !record.execution?.fx?.rate) {
    try {
      const quote = await api("/api/exchange-rate/hkd-cny");
      if (state.executingEventId !== record.id) return;
      fxInput.value = Number(quote.rate).toFixed(6);
      fxInput.dataset.asOf = quote.asOf;
      fxInput.dataset.source = quote.source;
      fxHint.textContent = quote.source + " 参考汇率 · " + quote.asOf + "，可按券商实际汇率修改";
    } catch (error) {
      fxHint.textContent = "自动获取失败，请手动填写港币兑人民币汇率";
    }
  }
  setTimeout(() => elements.executionForm.querySelector("input")?.focus(), 50);
}

function closeExecutionDialog() {
  elements.executionDialog.close();
  state.executingEventId = null;
}

async function saveExecution(event) {
  event.preventDefault();
  const legs = Array.from(document.querySelectorAll(".execution-leg")).map((leg) => ({
    symbol: leg.dataset.symbol,
    side: leg.dataset.side,
    price: Number(leg.querySelector(".execution-price").value),
    quantity: Number(leg.querySelector(".execution-quantity").value),
  }));
  const button = document.querySelector("#saveExecutionButton");
  button.disabled = true;
  try {
    const updated = await api("/api/trigger-history/" + state.executingEventId, {
      method: "PATCH",
      body: JSON.stringify({
        status: "EXECUTED",
        legs,
        fxRate: Number(document.querySelector("#executionFxRate").value),
        fxAsOf: document.querySelector("#executionFxRate").dataset.asOf,
        fxSource: document.querySelector("#executionFxRate").dataset.source,
      }),
    });
    replaceHistoryRecord(updated);
    closeExecutionDialog();
    render();
    showToast("执行记录已保存");
  } catch (error) {
    showToast("保存失败：" + error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function render() {
  const historyMode = state.filter === "HISTORY";
  const trashMode = state.filter === "TRASH";
  const gridMode = state.filter === "GRID";
  const rangeMode = state.filter === "RANGE";
  document.querySelector("#relationHeader").textContent = gridMode ? "网格区间" : rangeMode ? "交易边界" : "监控关系";
  document.querySelector("#priceHeader").textContent = (gridMode || rangeMode) ? "当前价格" : "现价 / 基准";
  document.querySelector("#metricHeader").textContent = gridMode ? "当前档位" : rangeMode ? "区间位置" : "当前价差";
  document.querySelector("#thresholdHeader").textContent = gridMode ? "下一网格" : rangeMode ? "买入 / 卖出" : "触发线";
  elements.grid.replaceChildren();
  elements.historyGrid.replaceChildren();

  if (historyMode) {
    state.triggerHistory.forEach((record) => elements.historyGrid.append(renderHistoryRow(record)));
  } else {
    const visible = state.strategies.filter(strategyMatches);
    visible.forEach((strategy, index) => elements.grid.append(renderCard(strategy, index)));
    elements.grid.hidden = visible.length === 0;
    document.querySelector("#strategyTable").hidden = visible.length === 0;
    elements.empty.hidden = visible.length !== 0;
  }

  document.querySelector("#strategyTable").hidden = historyMode || (!historyMode && elements.grid.children.length === 0);
  document.querySelector("#historyTable").hidden = !historyMode || state.triggerHistory.length === 0;
  const emptyTitle = document.querySelector("#emptyState h3");
  const emptyText = document.querySelector("#emptyState p");
  emptyTitle.textContent = trashMode ? "回收站为空" : "还没有监控策略";
  emptyText.textContent = trashMode ? "移至回收站的策略会保留在这里，可随时恢复。" : "新建单股、价差、网格或区间策略，持续监控交易机会。";
  elements.empty.hidden = historyMode || elements.grid.children.length !== 0;
  document.querySelector("#emptyHistory").hidden = !historyMode || state.triggerHistory.length !== 0;

  const liveStrategies = state.strategies.filter((item) => !item.deletedAt);
  const total = liveStrategies.length;
  const active = liveStrategies.filter((item) => item.enabled).length;
  const triggered = liveStrategies.filter((item) => item.lastEvaluation?.signal === "TRIGGERED").length;
  document.querySelector("#totalMetric").textContent = total;
  document.querySelector("#activeMetric").textContent = active;
  document.querySelector("#triggeredMetric").textContent = triggered;
  document.querySelector("#lastRefreshMetric").textContent = formatTime(state.system?.lastRefreshAt);
  document.querySelector("#intervalMetric").textContent = state.system?.tradingHoursOnly
    ? "工作日 09:30–16:30 · 每 " + (state.system?.intervalMinutes || 10) + " 分钟"
    : "每 " + (state.system?.intervalMinutes || 10) + " 分钟自动轮询";
  document.querySelector("#providerLabel").textContent = "行情源 " + (state.system?.provider || "—").toUpperCase();
  document.querySelectorAll(".sum-value, #providerLabel, #intervalMetric").forEach((element) => { element.title = element.textContent; });
}

async function loadData({ quiet = false } = {}) {
  try {
    const [strategyPayload, historyPayload, systemPayload] = await Promise.all([
      api("/api/strategies?includeDeleted=true"), api("/api/trigger-history"), api("/api/system"),
    ]);
    state.strategies = strategyPayload.items;
    state.triggerHistory = historyPayload.items;
    state.system = systemPayload;
    render();
  } catch (error) {
    if (!quiet) showToast(error.message, "error");
  }
}

async function refreshOne(button, id) {
  button.disabled = true;
  button.classList.add("loading");
  try {
    const updated = await api(`/api/strategies/${id}/refresh`, { method: "POST" });
    const index = state.strategies.findIndex((item) => item.id === id);
    if (index >= 0) state.strategies[index] = updated;
    await loadData({ quiet: true });
    showToast("策略行情已刷新");
  } catch (error) {
    await loadData({ quiet: true });
    showToast(error.message, "error");
  }
}

async function handleCardAction(event, strategy) {
  const action = event.target.dataset.action;
  if (!action) return;
  if (action === "edit") return openDialog(strategy);
  if (action === "delete") {
    if (!window.confirm("将“" + strategy.name + "”移至回收站？可随时恢复。")) return;
    try {
      await api(`/api/strategies/${strategy.id}`, { method: "DELETE" });
      await loadData({ quiet: true });
      showToast("策略已移至回收站");
    } catch (error) { showToast(error.message, "error"); }
  }
  if (action === "restore") {
    try {
      await api("/api/strategies/" + strategy.id + "/restore", { method: "POST" });
      await loadData({ quiet: true });
      showToast("策略已恢复，当前为暂停状态");
    } catch (error) { showToast(error.message, "error"); }
  }
  if (action === "toggle") {
    try {
      const updated = await api(`/api/strategies/${strategy.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !strategy.enabled }),
      });
      const index = state.strategies.findIndex((item) => item.id === strategy.id);
      state.strategies[index] = updated;
      await loadData({ quiet: true });
      showToast(updated.enabled ? "已恢复自动监控" : "已暂停自动监控");
    } catch (error) { showToast(error.message, "error"); }
  }
}

function syncTypeFields() {
  const formData = new FormData(elements.form);
  const type = formData.get("type");
  const isSingle = type === "SINGLE";
  const isSpread = type === "SPREAD";
  const isGrid = type === "GRID";
  const isRange = type === "RANGE";
  const triggerMode = formData.get("triggerMode") || "THRESHOLD_PCT";
  const targetMode = isSingle && triggerMode === "TARGET_PRICE";
  const percentageMode = isSpread || (isSingle && !targetMode);
  document.querySelectorAll(".spread-only").forEach((element) => { element.hidden = !isSpread; });
  document.querySelectorAll(".single-only").forEach((element) => { element.hidden = !isSingle; });
  document.querySelectorAll(".grid-only").forEach((element) => { element.hidden = !isGrid; });
  document.querySelectorAll(".range-only").forEach((element) => { element.hidden = !isRange; });
  document.querySelectorAll(".boundary-only").forEach((element) => { element.hidden = !(isGrid || isRange); });
  document.querySelectorAll(".percentage-only").forEach((element) => { element.hidden = !percentageMode; });
  document.querySelectorAll(".target-price-only").forEach((element) => { element.hidden = !targetMode; });
  elements.form.elements.symbolB.required = isSpread;
  elements.form.elements.referencePrice.required = isSingle;
  elements.form.elements.thresholdPct.required = percentageMode;
  elements.form.elements.targetPrice.required = targetMode;
  elements.form.elements.lowerPrice.required = isGrid || isRange;
  elements.form.elements.upperPrice.required = isGrid || isRange;
  elements.form.elements.gridCount.required = isGrid;
  document.querySelector("#referencePriceLabel").textContent = targetMode ? "当前价格" : "基准价格";
  document.querySelector("#referencePriceHint").textContent = targetMode
    ? "选择标的后自动带入当前价格，作为目标价判断的起始价格"
    : "选择标的后自动带入最新价格，作为计算涨跌幅的基准";
  const resetBaseline = elements.form.elements.resetBaseline;
  resetBaseline.closest(".reset-baseline").hidden = !isSpread || !state.editingId;
  elements.form.elements.basePriceA.disabled = resetBaseline.checked;
  elements.form.elements.basePriceB.disabled = resetBaseline.checked;
  document.querySelector("#symbolALabel").textContent = isSpread ? "当前持有 · 代码 A" : isGrid ? "网格标的" : isRange ? "区间交易标的" : "股票代码";
  document.querySelector("#lowerPriceLabel").textContent = isRange ? "买入下限价格" : "网格价格下限";
  document.querySelector("#upperPriceLabel").textContent = isRange ? "卖出上限价格" : "网格价格上限";
  elements.saveButton.textContent = isSpread ? "保存价差策略" : isGrid ? "保存网格策略" : isRange ? "保存区间策略" : targetMode ? "保存目标价策略" : "保存并获取行情";
}

function openDialog(strategy = null) {
  state.editingId = strategy?.id || null;
  elements.form.reset();
  resetSymbolPickers();
  elements.form.elements.enabled.checked = true;
  elements.typeSwitch.classList.toggle("editing", Boolean(strategy));
  document.querySelector("#dialogKicker").textContent = strategy ? "EDIT SIGNAL RULE" : "NEW SIGNAL RULE";
  document.querySelector("#dialogTitle").textContent = strategy ? "编辑策略" : "新建策略";

  if (strategy) {
    for (const [key, value] of Object.entries(strategy)) {
      const control = elements.form.elements[key];
      if (!control || value == null) continue;
      if (control instanceof RadioNodeList) {
        control.value = String(value);
      } else if (control.type === "checkbox") {
        control.checked = Boolean(value);
      } else {
        control.value = String(value);
      }
    }
  }
  syncTypeFields();
  elements.dialog.showModal();
  setTimeout(() => elements.form.elements.name.focus(), 50);
}

function closeDialog() {
  elements.dialog.close();
  state.editingId = null;
}

async function saveStrategy(event) {
  event.preventDefault();
  if (!validateSymbolInputs()) {
    const invalidInput = elements.form.querySelector(":invalid");
    showToast(invalidInput?.validationMessage || "请从联想列表中选择有效标的", "error");
    invalidInput?.focus();
    return;
  }
  const formData = new FormData(elements.form);
  const payload = Object.fromEntries(formData.entries());
  payload.referencePrice = payload.referencePrice ? Number(payload.referencePrice) : null;
  payload.targetPrice = payload.targetPrice ? Number(payload.targetPrice) : null;
  payload.basePriceA = payload.basePriceA ? Number(payload.basePriceA) : null;
  payload.basePriceB = payload.basePriceB ? Number(payload.basePriceB) : null;
  payload.lowerPrice = payload.lowerPrice ? Number(payload.lowerPrice) : null;
  payload.upperPrice = payload.upperPrice ? Number(payload.upperPrice) : null;
  payload.gridCount = payload.gridCount ? Number(payload.gridCount) : null;
  payload.thresholdPct = Number(payload.thresholdPct);
  payload.enabled = elements.form.elements.enabled.checked;
  payload.resetBaseline = elements.form.elements.resetBaseline.checked;

  const isEditing = Boolean(state.editingId);
  elements.saveButton.disabled = true;
  const originalLabel = elements.saveButton.textContent;
  elements.saveButton.textContent = "正在获取行情…";
  try {
    const updated = await api(state.editingId ? `/api/strategies/${state.editingId}` : "/api/strategies", {
      method: state.editingId ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    });
    if (state.editingId) {
      const index = state.strategies.findIndex((item) => item.id === state.editingId);
      state.strategies[index] = updated;
    } else {
      state.strategies.unshift(updated);
    }
    closeDialog();
    await loadData({ quiet: true });
    showToast(isEditing ? "策略已更新" : "策略已创建");
  } catch (error) {
    showToast("保存失败：" + error.message, "error");
  } finally {
    elements.saveButton.disabled = false;
    elements.saveButton.textContent = originalLabel;
  }
}

async function refreshAll() {
  const button = elements.refreshAllButton;
  button.disabled = true;
  button.classList.add("loading");
  try {
    const result = await api("/api/refresh", { method: "POST" });
    await loadData({ quiet: true });
    showToast(result.failed ? `刷新完成：${result.succeeded} 成功，${result.failed} 失败` : `已刷新 ${result.succeeded} 条策略`, result.failed ? "error" : "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.classList.remove("loading");
  }
}

function updateCountdown() {
  const target = state.system?.nextRefreshAt ? new Date(state.system.nextRefreshAt).valueOf() : 0;
  const remaining = Math.max(0, target - Date.now());
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  const hours = Math.floor(minutes / 60);
  const minutePart = minutes % 60;
  document.querySelector("#countdown").textContent = !target
    ? "--:--"
    : hours > 0
      ? `${String(hours).padStart(2, "0")}:${String(minutePart).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  if (target && remaining === 0) setTimeout(() => loadData({ quiet: true }), 1_500);
}

document.querySelectorAll("[data-symbol-picker] input").forEach(setupSymbolPicker);
document.querySelector("#addButton").addEventListener("click", () => openDialog());
document.querySelector("#emptyAddButton").addEventListener("click", () => openDialog());
document.addEventListener("keydown", (event) => {
  const isEnter = event.key === "Enter";
  const isSpace = event.code === "Space";
  if ((!isEnter && !isSpace) || event.defaultPrevented || event.repeat || event.isComposing || elements.dialog.open || elements.executionDialog.open) return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  const interactive = event.target.closest("button, a, input, select, textarea, [contenteditable='true']");
  if (interactive) return;
  event.preventDefault();
  if (isEnter) openDialog();
  else if (!elements.refreshAllButton.disabled) refreshAll();
});
document.querySelectorAll(".close-dialog").forEach((button) => button.addEventListener("click", closeDialog));
document.querySelectorAll('input[name="type"], input[name="triggerMode"]').forEach((input) => input.addEventListener("change", syncTypeFields));
elements.form.elements.resetBaseline.addEventListener("change", syncTypeFields);
document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  state.filter = button.dataset.filter;
  render();
}));
elements.form.addEventListener("invalid", (event) => {
  const field = event.target;
  setTimeout(() => showToast(field.validationMessage || "请检查并完成必填项", "error"), 0);
}, true);
elements.form.addEventListener("submit", saveStrategy);
elements.executionForm.addEventListener("submit", saveExecution);
document.querySelectorAll(".close-execution-dialog").forEach((button) => button.addEventListener("click", closeExecutionDialog));
elements.refreshAllButton.addEventListener("click", refreshAll);
elements.dialog.addEventListener("click", (event) => { if (event.target === elements.dialog) closeDialog(); });
elements.executionDialog.addEventListener("click", (event) => { if (event.target === elements.executionDialog) closeExecutionDialog(); });
document.addEventListener("click", () => document.querySelectorAll(".card-menu").forEach((menu) => { menu.hidden = true; }));

await loadData();
updateCountdown();
setInterval(updateCountdown, 1_000);
setInterval(() => loadData({ quiet: true }), 60_000);
