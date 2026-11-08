// Guarded SQLite backup restore used as the migration rollback path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { restoreBackup } from '../scripts/restore_backup.js';

// Creates a minimal application-shaped SQLite file with one marker value.
function createDatabase(file, marker) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE tokens (id INTEGER PRIMARY KEY);
    CREATE TABLE models (id INTEGER PRIMARY KEY);
    CREATE TABLE usage (id INTEGER PRIMARY KEY);
    CREATE TABLE token_usage_events (id INTEGER PRIMARY KEY);
    CREATE TABLE marker (value TEXT);
  `);
  db.prepare('INSERT INTO marker (value) VALUES (?)').run(marker);
  db.close();
}

// Reads the marker value from a database file.
function markerOf(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT value FROM marker').get().value;
  } finally {
    db.close();
  }
}

test('restore replaces the database and keeps a safety snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-restore-'));
  const dbPath = path.join(dir, 'gateway.db');
  const backupPath = path.join(dir, 'backup.db');
  try {
    createDatabase(dbPath, 'current');
    createDatabase(backupPath, 'backup');
    assert.throws(
      () => restoreBackup({ dbPath, backupPath, confirm: false }),
      /explicit confirmation/,
    );
    const result = restoreBackup({ dbPath, backupPath, confirm: true });
    assert.equal(markerOf(dbPath), 'backup');
    assert.ok(result.safetyBackup, 'safety snapshot recorded');
    assert.equal(markerOf(result.safetyBackup), 'current', 'safety snapshot holds the replaced database');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
