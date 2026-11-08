// Restores a verified SQLite snapshot over the live database after service shutdown.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REQUIRED_TABLES = ['schema_migrations', 'tokens', 'models'];

// Verifies that a SQLite file is healthy and carries the application schema.
function validateDatabase(file) {
  if (!fs.existsSync(file)) throw new Error(`database file not found: ${file}`);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') throw new Error(`integrity check failed for ${file}: ${integrity}`);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const table of REQUIRED_TABLES) {
      if (!tables.has(table)) throw new Error(`database ${file} is missing table ${table}`);
    }
  } finally {
    db.close();
  }
}

// Replaces the target database with a backup, keeping a safety snapshot first.
export function restoreBackup({ dbPath, backupPath, confirm = false }) {
  const target = path.resolve(dbPath);
  const backup = path.resolve(backupPath);
  if (!confirm) throw new Error('restore requires explicit confirmation');
  if (target === backup) throw new Error('backup and target database must differ');
  validateDatabase(backup);

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const safety = `${target}.pre-restore-${stamp}.db`;
  const targetMode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : null;
  if (fs.existsSync(target)) {
    if (fs.existsSync(safety)) throw new Error(`safety backup already exists: ${safety}`);
    const current = new DatabaseSync(target);
    try {
      current.exec(`VACUUM INTO '${safety.replaceAll("'", "''")}'`);
    } finally {
      current.close();
    }
  }

  const temp = `${target}.restore-${stamp}.tmp`;
  try {
    fs.copyFileSync(backup, temp);
    validateDatabase(temp);
    fs.rmSync(`${target}-wal`, { force: true });
    fs.rmSync(`${target}-shm`, { force: true });
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  validateDatabase(target);
  if (targetMode !== null) fs.chmodSync(target, targetMode);
  return { dbPath: target, backupPath: backup, safetyBackup: fs.existsSync(safety) ? safety : null };
}

// Runs the restore CLI; requires --yes and a stopped gateway.
function main() {
  const args = process.argv.slice(2);
  const backupArg = args.find((arg) => !arg.startsWith('--'));
  const dbArg = args.find((arg) => arg.startsWith('--db='))?.slice('--db='.length);
  const dbPath = path.resolve(dbArg || process.env.DB_PATH || path.join('storage', 'gateway.db'));
  if (!backupArg) {
    console.error('usage: npm run db:restore -- <backup.db> [--db=storage/gateway.db] --yes');
    process.exit(2);
  }
  if (!args.includes('--yes')) {
    console.error(`This replaces ${dbPath} with ${path.resolve(backupArg)}.`);
    console.error('Stop the gateway, then re-run with --yes.');
    process.exit(2);
  }
  try {
    const result = restoreBackup({ dbPath, backupPath: backupArg, confirm: true });
    console.log(JSON.stringify({ restored: true, ...result }, null, 2));
  } catch (error) {
    console.error(`restore failed: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
