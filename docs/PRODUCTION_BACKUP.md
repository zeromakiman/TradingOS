# Practical production backup

Use a private encrypted backup directory outside the deployment/repository. Pause personal writes while exporting so the database and images describe the same point in time. Keep dated copies off this computer. No restore drill or backup export is claimed by this document.

## PostgreSQL

Install the official Supabase CLI and its required Docker runtime. In Supabase's Connect panel, obtain the session-pooler connection string and enter its database password locally. Never send the connection string to chat, commit it, or place it literally in shell history. Store it temporarily in `TRADING_BACKUP_DB_URL` using a private local secret-entry mechanism.

From the encrypted backup directory:

```powershell
supabase db dump --db-url $env:TRADING_BACKUP_DB_URL -f roles.sql --role-only
supabase db dump --db-url $env:TRADING_BACKUP_DB_URL -f schema.sql
supabase db dump --db-url $env:TRADING_BACKUP_DB_URL -f data.sql --use-copy --data-only -x storage.buckets_vectors -x storage.vector_indexes
supabase db dump --db-url $env:TRADING_BACKUP_DB_URL -f history_schema.sql --schema supabase_migrations
supabase db dump --db-url $env:TRADING_BACKUP_DB_URL -f history_data.sql --use-copy --data-only --schema supabase_migrations
```

Preserve the source release and migrations 0001–0007, including the custom Storage policies. Follow the official guide for custom auth/storage schema differences, managed schemas and encryption-key requirements during recovery. Clear the temporary connection variable afterward. [Supabase export/restore procedure](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)

Check every command exits successfully and each expected file is nonempty. Record date, project, release commit and file hashes. Preserve auth ownership IDs and relationships when restoring; do not replace them with newly generated users.

## Screenshots are a separate backup

Database exports contain object metadata, **not image bytes**. On the Free plan, do not assume automatic daily downloadable backups or PITR; maintain regular off-site exports or deliberately select a plan with the required recovery features. [Supabase backup limitations](https://supabase.com/docs/guides/platform/backups)

Download the full private `setup-screenshots` bucket using an authenticated Storage client/CLI into a matching folder tree. Include soft-removed evidence. Retain every original object path and a manifest containing screenshot ID, proposal ID, MIME type, size and SHA-256 from `setup_screenshots`. Compare downloaded counts, byte sizes and hashes with the metadata. Do not make the bucket public or overwrite/delete remote objects during backup.

The Supabase CLI supports recursive Storage copy with `storage cp`, `--recursive`, `--linked` and `--experimental`; use its documented download direction for the installed version. Alternatively, download individual objects from Storage in the dashboard while the collection is small, retaining the exact paths in the manifest. [Storage CLI reference](https://supabase.com/docs/reference/cli/supabase-storage-cp)

## Daily user-level copy

In EDGE, choose the date range/account and select **Export filtered closed trades · CSV**. Store the CSV with the dated backup. It covers completed outcomes under those filters; it omits unclosed plans, proposals, full events, governing versions and screenshots, so it is not a database restore source.

Back up after active days and before future schema changes. A full restore rehearsal is not required before this deployment, per the user's deployment instructions. Before relying on recovery, restore a copy into an isolated project, verify counts/hashes, private access and original outcomes, then document the result. Never rehearse by resetting the only live database.
