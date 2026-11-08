// Shared TPS routing limits used by the gateway, model validation, and configuration.
export const TPS_WINDOW_SIZE = 12;
export const TPS_DEMOTE_COUNT = 10;
export const TPS_MIN_CONTENT_TOKENS = 100;
export const TPS_STALE_SAMPLE_MS = 600000;
export const TPS_RESTORE_STREAK = 3;
export const TPS_RESTORE_MULTIPLIER = 1.1;
export const TPS_MIN_PROBE_INTERVAL_MS = 60000;
export const TPS_MAX_PROBE_INTERVAL_MS = 1800000;
export const TPS_DEFAULT_PROBE_INTERVAL_MS = 300000;
export const TPS_MAX_PROBE_TOKENS = 8000;
export const TPS_COMPLETE_FINISH_REASONS = new Set(['stop', 'end_turn', 'stop_sequence', 'eos']);
