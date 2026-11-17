# Release notes

## 0.9.9

- Restore SQL tabs, active workspace, and editor preferences after a restart or update. Choose **Resume SQL** in Overview to reopen drafts without connecting to a database.
- Save recovery data in the local app data folder. EZ Bench migrates existing editor recovery and keeps saved connections, snippets, query history, and history preferences in that folder.
- Warn before closing or installing an update if SQL file changes, private SQL, table edits, or active work need attention. Save private SQL to a file when you want to keep it. Apply table edits before leaving.
- Preserve the theme, sidebar state, SQL word wrap, editor height, and **Stop script on error** setting.

## 0.9.8

- Published the runnable Windows source with the updated EZ Bench logo, README screenshots, and contribution instructions.
- Added Git-based Windows setup, a desktop shortcut, and a link to the Git update guide from the app.
- Covered SQLite, MySQL, MariaDB, and PostgreSQL with live database checks and SQL Server with adapter tests. See the [0.9.8 verification report](docs/VERIFICATION-0.9.8.md) for coverage and limitations.
