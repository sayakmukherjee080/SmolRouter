// Migration runner: schema creation and idempotency.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations } from '../src/store/db.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

test('checksum mismatches are detected without re-applying', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-migrations-checksum-'));
  const migrations = path.join(dir, 'migrations');
  fs.mkdirSync(migrations);
  const file = path.join(migrations, '001_test.sql');
  fs.writeFileSync(file, 'CREATE TABLE widget (id INTEGER PRIMARY KEY);\n');
  const db = openDatabase(path.join(dir, 'test.db'));
  const warnings = [];
  const logger = { info: () => {}, warn: (message, fields) => warnings.push({ message, fields }) };
  try {
    assert.equal(runMigrations(db, migrations, logger), 1, 'first run applies');
    fs.writeFileSync(file, 'CREATE TABLE widget (id INTEGER PRIMARY KEY);\n-- edited after the fact\n');
    assert.equal(runMigrations(db, migrations, logger), 0, 'second run applies nothing');
    assert.ok(warnings.some((entry) => entry.message === 'migration checksum mismatch'), 'tampered history is flagged');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrations apply once and create the full schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-migrations-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  try {
    const first = runMigrations(db, MIGRATIONS_DIR, null);
    assert.ok(first >= 1, 'at least one migration applied');
    const second = runMigrations(db, MIGRATIONS_DIR, null);
    assert.equal(second, 0, 'second run applies nothing');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    for (const table of ['models', 'providers', 'provider_keys', 'routes', 'tokens', 'token_models',
      'telemetry', 'usage', 'settings', 'admin', 'audit', 'schema_migrations']) {
      assert.ok(tables.includes(table), `table ${table} exists`);
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('upgrade backfills token usage and rebuilds usage with currency', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-migrations-upgrade-'));
  const migrations = path.join(dir, 'migrations');
  fs.mkdirSync(migrations);
  const files = fs.readdirSync(MIGRATIONS_DIR).sort();
  const copyThrough = (last) => {
    for (const file of files) {
      if (file > last) break;
      fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(migrations, file));
    }
  };
  const db = openDatabase(path.join(dir, 'test.db'));
  try {
    copyThrough('005_upstream_cost.sql');
    runMigrations(db, migrations, null);
    const now = Date.now();
    db.prepare(`INSERT INTO tokens
      (key_hash, label, enabled, daily_request_limit, monthly_request_limit, daily_spend_limit, monthly_spend_limit, created_at)
      VALUES (?, 'legacy', 1, 5, NULL, 8, NULL, ?)`).run('c'.repeat(64), now);
    const tokenId = Number(db.prepare('SELECT id FROM tokens').get().id);
    db.prepare('INSERT INTO models (name, balance_strategy, created_at) VALUES (?, ?, ?)').run('legacy-model', 'round_robin', now);
    const insertLegacy = db.prepare(`INSERT INTO telemetry
      (ts, token_id, model_id, status, latency_ms, input_tokens, output_tokens, est_cost, is_probe)
      VALUES (?, ?, 1, ?, 1, 10, 5, ?, ?)`);
    insertLegacy.run(now - 3000, tokenId, 200, 0.001, 0);
    insertLegacy.run(now - 2000, tokenId, 500, 0.5, 0);
    insertLegacy.run(now - 1000, tokenId, 200, 0.25, 1);

    copyThrough('006_pricing_budgets_currency.sql');
    runMigrations(db, migrations, null);
    const rules = db.prepare('SELECT * FROM token_budget_rules ORDER BY id').all();
    assert.equal(rules.length, 2, 'legacy caps became request and amount rules');

    // A post-006 event and its recorded token usage must not be duplicated by 007.
    const post = now + 1000;
    db.prepare(`INSERT INTO telemetry
      (ts, token_id, model_id, status, latency_ms, input_tokens, output_tokens, downstream_cost, currency, fx_rate, is_probe)
      VALUES (?, ?, 1, 200, 1, 7, 3, 0.25, 'USD', 1, 0)`).run(post, tokenId);
    db.prepare(`INSERT INTO token_usage_events
      (ts, token_id, requests, tokens_in, tokens_out, downstream_cost, currency, fx_rate, is_cache)
      VALUES (?, ?, 1, 7, 3, 0.25, 'USD', 1, 0)`).run(post, tokenId);

    copyThrough('009_backfill_legacy_spend.sql');
    runMigrations(db, migrations, null);

    const events = db.prepare('SELECT * FROM token_usage_events ORDER BY ts').all();
    assert.equal(events.length, 2, 'only successful legacy attempts are backfilled, once');
    assert.equal(events[0].tokens_in, 10);
    assert.equal(events[0].tokens_out, 5);
    assert.equal(events[0].downstream_cost, 0.001, 'legacy spend is restored from upstream estimated cost');
    assert.equal(events[1].ts, post, 'already-recorded post-upgrade usage is not duplicated');
    assert.equal(events[1].downstream_cost, 0.25, 'post-pricing events keep their recorded downstream charge');

    const amountRule = db.prepare("SELECT * FROM token_budget_rules WHERE metric = 'amount'").get();
    assert.equal(amountRule.currency, 'USD');
    assert.equal(amountRule.limit_value, 8);

    const model = db.prepare('SELECT downstream_currency FROM models').get();
    assert.equal(model.downstream_currency, 'USD');

    const usageColumns = db.prepare('PRAGMA table_info(usage)').all();
    const primary = usageColumns.filter((row) => row.pk > 0).map((row) => row.name).sort();
    assert.deepEqual(primary, ['currency', 'entity', 'entity_id', 'window_start'], 'currency is part of the usage key');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
