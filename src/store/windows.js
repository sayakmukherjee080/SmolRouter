// Timezone-aware budget windows: hour, n-hour, day, n-day, week, and month.
const DAY_MS = 86400000;
const HOUR_MS = 3600000;

// Returns the UTC day window start (ms) containing the timestamp.
export function dayWindow(now) {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

// Returns the UTC month window start (ms) containing the timestamp.
export function monthWindow(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

// Returns a valid IANA timezone, falling back to UTC for malformed legacy values.
const TIME_ZONE_CACHE = new Map();

export function safeTimeZone(value) {
  const timeZone = String(value || 'UTC');
  const cached = TIME_ZONE_CACHE.get(timeZone);
  if (cached) return cached;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    TIME_ZONE_CACHE.set(timeZone, timeZone);
    return timeZone;
  } catch {
    TIME_ZONE_CACHE.set(timeZone, 'UTC');
    return 'UTC';
  }
}

// Returns wall-clock parts for a timestamp in an IANA timezone.
export function zonedParts(ms, timeZone = 'UTC') {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(ms))) parts[part.type] = part.value;
  const hour = Number(parts.hour) % 24;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// Returns the timezone offset in milliseconds at a timestamp.
function offsetMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return local - Math.floor(ms / 1000) * 1000;
}

// Converts local wall-clock components to a UTC timestamp, resolving DST offsets iteratively.
export function localToUtc(year, month, day, hour, minute, timeZone = 'UTC') {
  const zone = safeTimeZone(timeZone);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const next = target - offsetMs(guess, zone);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

// Adds days to a UTC date triple.
function addDays(year, month, day, days) {
  const date = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// Returns the number of days in a month.
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Converts a naive local date in ms to UTC using its wall-clock components.
function localMsToUtc(localMs, timeZone) {
  const date = new Date(localMs);
  return localToUtc(
    date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
    date.getUTCHours(), date.getUTCMinutes(), timeZone,
  );
}

// Parses a rule anchor as an integer when present.
function anchorInt(rule, fallback) {
  const value = Number(rule.anchor);
  return Number.isInteger(value) ? value : fallback;
}

// Returns the active window for a budget rule at a timestamp.
export function ruleWindow(rule, now = Date.now()) {
  const timeZone = safeTimeZone(rule.timezone);
  const period = rule.period;
  const count = Math.max(1, Number(rule.period_count) || 1);
  const resetMinutes = Math.max(0, Math.min(1439, Number(rule.reset_time) || 0));
  const resetHour = Math.floor(resetMinutes / 60);
  const resetMinute = resetMinutes % 60;
  let p;
  try {
    p = zonedParts(now, timeZone);
  } catch {
    p = zonedParts(now, 'UTC');
  }
  const nowLocal = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);

  if (period === 'hour' || period === 'n_hours') {
    const anchorHour = period === 'hour' ? 0 : anchorInt(rule, 0);
    let base = Date.UTC(p.year, p.month - 1, p.day, anchorHour, 0, 0);
    if (nowLocal < base) {
      const previous = addDays(p.year, p.month, p.day, -1);
      base = Date.UTC(previous.year, previous.month - 1, previous.day, anchorHour, 0, 0);
    }
    const step = count * HOUR_MS;
    const startLocal = base + Math.floor((nowLocal - base) / step) * step;
    const endLocal = startLocal + step;
    return { start: localMsToUtc(startLocal, timeZone), end: localMsToUtc(endLocal, timeZone) };
  }

  if (period === 'day') {
    let startLocal = Date.UTC(p.year, p.month - 1, p.day, resetHour, resetMinute, 0);
    if (nowLocal < startLocal) {
      const previous = addDays(p.year, p.month, p.day, -1);
      startLocal = Date.UTC(previous.year, previous.month - 1, previous.day, resetHour, resetMinute, 0);
    }
    const next = addDays(new Date(startLocal).getUTCFullYear(), new Date(startLocal).getUTCMonth() + 1, new Date(startLocal).getUTCDate(), 1);
    const endLocal = Date.UTC(next.year, next.month - 1, next.day, resetHour, resetMinute, 0);
    return { start: localMsToUtc(startLocal, timeZone), end: localMsToUtc(endLocal, timeZone) };
  }

  if (period === 'n_days') {
    const anchorDate = /^\d{4}-\d{2}-\d{2}$/.test(String(rule.anchor || ''))
      ? String(rule.anchor).split('-').map(Number)
      : [1970, 1, 1];
    const anchorLocal = Date.UTC(anchorDate[0], anchorDate[1] - 1, anchorDate[2], resetHour, resetMinute, 0);
    const step = count * DAY_MS;
    const startLocal = anchorLocal + Math.floor((nowLocal - anchorLocal) / step) * step;
    const endLocal = startLocal + step;
    return { start: localMsToUtc(startLocal, timeZone), end: localMsToUtc(endLocal, timeZone) };
  }

  if (period === 'week') {
    const anchorDay = ((anchorInt(rule, 1) % 7) + 7) % 7;
    const currentDay = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    const diff = (currentDay - anchorDay + 7) % 7;
    const startDate = addDays(p.year, p.month, p.day, -diff);
    let startLocal = Date.UTC(startDate.year, startDate.month - 1, startDate.day, resetHour, resetMinute, 0);
    if (nowLocal < startLocal) {
      const previous = addDays(startDate.year, startDate.month, startDate.day, -7);
      startLocal = Date.UTC(previous.year, previous.month - 1, previous.day, resetHour, resetMinute, 0);
    }
    const endDate = addDays(new Date(startLocal).getUTCFullYear(), new Date(startLocal).getUTCMonth() + 1, new Date(startLocal).getUTCDate(), 7);
    const endLocal = Date.UTC(endDate.year, endDate.month - 1, endDate.day, resetHour, resetMinute, 0);
    return { start: localMsToUtc(startLocal, timeZone), end: localMsToUtc(endLocal, timeZone) };
  }

  // month
  const anchorDay = Math.max(1, anchorInt(rule, 1));
  let year = p.year;
  let month = p.month;
  let day = Math.min(anchorDay, daysInMonth(year, month));
  let startLocal = Date.UTC(year, month - 1, day, resetHour, resetMinute, 0);
  if (nowLocal < startLocal) {
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
    day = Math.min(anchorDay, daysInMonth(year, month));
    startLocal = Date.UTC(year, month - 1, day, resetHour, resetMinute, 0);
  }
  let nextYear = new Date(startLocal).getUTCFullYear();
  let nextMonth = new Date(startLocal).getUTCMonth() + 1;
  nextMonth += 1;
  if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }
  const nextDay = Math.min(anchorDay, daysInMonth(nextYear, nextMonth));
  const endLocal = Date.UTC(nextYear, nextMonth - 1, nextDay, resetHour, resetMinute, 0);
  return { start: localMsToUtc(startLocal, timeZone), end: localMsToUtc(endLocal, timeZone) };
}

// Formats a rule period for API and UI labels.
export function periodLabel(rule) {
  if (rule.period === 'hour') return 'hourly';
  if (rule.period === 'n_hours') return `${rule.period_count}h`;
  if (rule.period === 'n_days') return `${rule.period_count}d`;
  if (rule.period === 'week') return 'weekly';
  return rule.period;
}
