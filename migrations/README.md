# Migrations

This project uses forward-only SQLite migrations. The runner applies each `.sql` file once in
filename order and records its checksum in `schema_migrations`; editing an applied migration is
reported as a checksum mismatch.

Rollback is backup-based by design. Stop the gateway, then restore a verified snapshot:

```bash
npm run db:restore -- storage/backups/gateway-YYYYMMDDHHMMSS.db --yes
```

The restore tool validates the snapshot, writes a `pre-restore` safety copy of the current
database, replaces the database atomically, and verifies the restored file. Timestamped
`backup_*_remediation` tables remain available inside the database for row-level recovery.
