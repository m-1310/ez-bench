# Native database tools

EZ Bench connects to servers through its bundled drivers. For full backup and restore, install the tools for your database engine and select their executable paths in **Database tools**.

| Engine | Backup | Restore |
| --- | --- | --- |
| MySQL | `mysqldump.exe` | `mysql.exe` |
| MariaDB | `mariadb-dump.exe` | `mariadb.exe` |
| PostgreSQL | `pg_dump.exe` | `pg_restore.exe` |

Select vendor tools compatible with the target server. SQLite uses the built-in runtime for backup and restore. For SQL Server `.bak` files, use your server's backup tools. See the [transfer guide](../app/README.md#full-database-backup-and-restore) for scope, confirmation and SSH behavior.

Standard builds contain the application runtime and drivers. Vendor executables stay outside the repository. If you prepare a separate distribution that includes vendor binaries, preserve their license notices and meet the applicable redistribution terms.
