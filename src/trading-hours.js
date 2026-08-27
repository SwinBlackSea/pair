const CHINA_OFFSET_MS = 8 * 60 * 60 * 1_000;
const SESSION_START = 9 * 60 + 30;
const SESSION_END = 16 * 60 + 30;

function localParts(date) {
  const local = new Date(date.valueOf() + CHINA_OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    dayOfMonth: local.getUTCDate(),
    dayOfWeek: local.getUTCDay(),
    minuteOfDay: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

function fromLocalParts(year, month, dayOfMonth, minuteOfDay) {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return new Date(Date.UTC(year, month, dayOfMonth, hour, minute) - CHINA_OFFSET_MS);
}

export function isStrategyTradingTime(_strategy, date = new Date()) {
  const parts = localParts(date);
  if (parts.dayOfWeek === 0 || parts.dayOfWeek === 6) return false;
  return parts.minuteOfDay >= SESSION_START && parts.minuteOfDay < SESSION_END;
}

export function nextStrategyTradingTime(strategy, earliest = new Date()) {
  if (isStrategyTradingTime(strategy, earliest)) return new Date(earliest);
  const start = localParts(earliest);

  for (let offset = 0; offset < 8; offset += 1) {
    const localDay = new Date(Date.UTC(start.year, start.month, start.dayOfMonth + offset));
    const dayOfWeek = localDay.getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;
    const candidate = fromLocalParts(
      localDay.getUTCFullYear(),
      localDay.getUTCMonth(),
      localDay.getUTCDate(),
      SESSION_START,
    );
    if (candidate >= earliest) return candidate;
  }
  return new Date(earliest.valueOf() + 24 * 60 * 60 * 1_000);
}
