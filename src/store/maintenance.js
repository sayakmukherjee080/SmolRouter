// Scheduled retention maintenance for telemetry and usage tables.
import { dayWindow, monthWindow, ruleWindow } from './windows.js';

const DAY_MS = 86400000;

export function createMaintenanceManager({ db, registry, config, logger }) {
  let timer = null;

  // Returns the oldest start of any active budget window, or null when none exist.
  function protectedWindowStart(now) {
    let oldest = null;
    const rules = db.prepare('SELECT * FROM token_budget_rules WHERE enabled = 1').all();
    for (const row of rules) {
      try {
        const window = ruleWindow({
          metric: row.metric,
          period: row.period,
          period_count: row.period_count,
          timezone: row.timezone,
          reset_time: row.reset_time,
          anchor: row.anchor,
        }, now);
        if (oldest === null || window.start < oldest) oldest = window.start;
      } catch (error) {
        logger?.warn('budget window unavailable during prune', { ruleId: row.id, error: error.message });
      }
    }
    return oldest;
  }

  // Runs one prune pass and returns the deleted row counts.
  function run() {
    const now = Date.now();
    const telemetryDays = registry.setting('telemetry_retention_days', config.telemetryRetentionDays);
    const usageDays = registry.setting('usage_retention_days', config.usageRetentionDays);
    const tokenUsageDays = registry.setting('token_usage_retention_days', config.tokenUsageRetentionDays);
    let deletedTelemetry = 0;
    let deletedUsage = 0;
    let deletedTokenUsage = 0;
    if (telemetryDays > 0) {
      deletedTelemetry = Number(db.prepare('DELETE FROM telemetry WHERE ts < ?')
        .run(now - telemetryDays * DAY_MS).changes);
    }
    if (usageDays > 0) {
      // Never prune the current month: token monthly budgets rebuild from these rows.
      const cutoff = Math.min(dayWindow(now - usageDays * DAY_MS), monthWindow(now));
      deletedUsage = Number(db.prepare('DELETE FROM usage WHERE window_start < ?')
        .run(cutoff).changes);
    }
    if (tokenUsageDays > 0) {
      // Never prune events still inside a current budget window; long windows can
      // start earlier than the retention cutoff.
      const required = protectedWindowStart(now);
      let cutoff = now - tokenUsageDays * DAY_MS;
      if (required !== null) cutoff = Math.min(cutoff, required);
      deletedTokenUsage = Number(db.prepare('DELETE FROM token_usage_events WHERE ts < ?')
        .run(cutoff).changes);
    }
    if (deletedTelemetry || deletedUsage || deletedTokenUsage) {
      logger?.info('retention prune', { deletedTelemetry, deletedUsage, deletedTokenUsage });
    }
    return { deletedTelemetry, deletedUsage, deletedTokenUsage };
  }

  // Starts the maintenance timer, honouring the stored interval override.
  function start() {
    if (!config.maintenanceEnabled || timer) return;
    const interval = registry.setting('maintenance_interval_ms', config.maintenanceIntervalMs);
    timer = setInterval(() => {
      try {
        run();
      } catch (error) {
        logger?.error('maintenance run failed', { error: error.message });
      }
    }, interval);
    timer.unref?.();
  }

  // Stops the maintenance timer.
  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return { run, start, stop };
}
