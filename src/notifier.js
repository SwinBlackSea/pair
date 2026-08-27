export class TelegramNotifier {
  constructor({ token, chatId, fetchImpl = fetch, maxAttempts = 3, retryDelayMs = 300 } = {}) {
    this.token = String(token || "").trim();
    this.chatId = String(chatId || "").trim();
    this.fetchImpl = fetchImpl;
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
    this.enabled = Boolean(this.token && this.chatId);
  }

  async sendTriggered(strategy) {
    if (!this.enabled) return { skipped: true };
    const evaluation = strategy.lastEvaluation || {};
    const metric = Number(evaluation.metricPct);
    const metricText = Number.isFinite(metric) ? `${metric > 0 ? "+" : ""}${metric.toFixed(2)}%` : "—";
    const relation = strategy.type === "SPREAD"
      ? `${strategy.symbolA} → ${strategy.symbolB}`
      : strategy.symbolA;
    const triggerLine = strategy.type === "GRID"
      ? `网格区间：${strategy.lowerPrice}–${strategy.upperPrice}（${strategy.gridCount} 格）`
      : strategy.type === "RANGE"
        ? `交易边界：买入 ${strategy.lowerPrice} / 卖出 ${strategy.upperPrice}`
        : `触发线：${Number(strategy.thresholdPct).toFixed(2)}%`;
    const metricLabel = ["GRID", "RANGE"].includes(strategy.type) ? "区间位置" : "当前价差";
    const text = [
      "🚨 价差哨兵 · 策略已触发",
      strategy.name,
      relation,
      `${metricLabel}：${metricText}`,
      triggerLine,
      evaluation.message || "请检查策略详情",
    ].join("\n");

    let response;
    let lastConnectionError;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.chatId, text }),
          signal: AbortSignal.timeout(8_000),
        });
        break;
      } catch (error) {
        lastConnectionError = error;
        if (attempt + 1 < this.maxAttempts && this.retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * (attempt + 1)));
        }
      }
    }
    if (!response) throw new Error(`Telegram 连接失败：${lastConnectionError.message}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(`Telegram 通知失败：${payload.description || `HTTP ${response.status}`}`);
    }
    return { sent: true };
  }
}
