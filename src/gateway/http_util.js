// HTTP helpers for upstream attempts: idle watchdogs and Retry-After parsing.
export function createIdleWatchdog(ms, onIdle) {
  let timer = null;
  return {
    touch() {
      clearTimeout(timer);
      timer = setTimeout(onIdle, ms);
    },
    stop() {
      clearTimeout(timer);
    },
  };
}

// Parses Retry-After seconds or HTTP-date into milliseconds.
export function retryAfterMs(response) {
  const header = response.headers.get('retry-after');
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}
