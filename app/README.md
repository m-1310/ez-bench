# EZ Bench

A free Windows 10 and later (x64) SQL workspace for local files and remote database servers. The app header, Windows executable and installer share a graphite icon with an ivory and copper database stack. The workspace offers graphite and warm paper themes, connection and file actions, and a local SQLite playground.

## Run EZ Bench

Follow the [root README](../README.md) to launch from source. For a locally built installer, follow the [Windows packaging guide](../docs/RELEASING.md). For remote access, choose **New connection** and enter the host, port and credentials from your database administrator.

## Supported databases

| Engine | Connection | Default port | Verification |
|---|---|---|---|
| MySQL | Local or remote server, optional verified TLS | 3306 | Real MySQL 8.4.13, including desktop UI |
| MariaDB | MySQL-compatible protocol, optional verified TLS | 3306 | Real MariaDB 11.4.13, including grid edits, native transfer and TLS |
| PostgreSQL | Local or remote server, optional verified TLS | 5432 | Real PostgreSQL 18.6, including desktop UI |
| SQL Server | SQL authentication, optional verified TLS | 1433 | Driver and transaction tests; a real SQL Server was not tested |
| SQLite | Existing or new local file | — | Real files and desktop UI tested |

These are database engines, each with its own SQL dialect. EZ Bench does not translate SQL between them, install database servers, or claim support for every SQL database. PostgreSQL connections require an initial database. SQL Server uses the login's default schema for unqualified queries; table previews use qualified names.

## Start working

Use **New connection** to choose an engine and enter your server details. **Test connection** checks a separate connection without saving a profile or disconnecting the active workspace. **Save profile** stores metadata only. Passwords are used in memory and not saved. Optional TLS verifies the certificate and server identity using the runtime's trust roots. For MySQL and MariaDB with TLS, enter the hostname listed in the server certificate in **Host**, including when you use an SSH tunnel.

Use **Open local DB** for SQLite files, **Create database** for a new empty SQLite file, or **Open playground** for a separate persistent sample database. Existing databases are not seeded with sample tables.

## Live databases through SSH

In **New connection**, enter the database engine, host, port and database login. Enable **Connect through an SSH tunnel** and enter the separate SSH gateway host, port and user. Database Host/Port are reached from the SSH server: use `127.0.0.1` when the database runs on the gateway, or its private hostname when it runs elsewhere.

Choose SSH **Password** or **Private key** authentication. The key file must be an absolute OpenSSH/PEM private-key path; encrypted keys can use a session-only passphrase. Database passwords, SSH passwords and key passphrases are never saved. Profiles retain endpoint metadata, authentication method, key-file path and the trusted host fingerprint.

Use **Verify host** to inspect the SSH server's SHA256 host-key fingerprint before connecting. This probe does not authenticate. Compare the fingerprint with a trusted value from your administrator, then select **Trust this host key** only when it matches. Unknown and changed fingerprints block authentication; the app never automatically accepts a changed key. Editing the gateway host/port clears its trusted pin. **Test connection** uses a separate temporary tunnel and preserves the active workspace.

The active connection owns an ephemeral loopback listener and SSH forwarding channels. Queries, table edits and supported native backups/restores reuse that transport. Disconnect, failed connection and worker cancellation close owned resources. An unexpected SSH drop requires reconnecting; writes are not automatically retried. The Database panel shows the gateway, SSH user and host fingerprint alongside the original database endpoint.

SSH encrypts the tunnel. Enable database TLS when the database connection itself requires encryption. Interactive drivers use the database hostname for certificate verification. PostgreSQL native tools use separate host and hostaddr values. Use direct verified TLS or run vendor backup/restore on the server for MySQL and MariaDB when the database requires TLS. The native client cannot preserve hostname verification through an SSH tunnel.

Use an explicit gateway and password or OpenSSH/PEM key. Live SSH validation covers MySQL, MariaDB and PostgreSQL. SQL Server has targeted adapter tests.

## SQL tabs and saved profiles

Middle-click a tab to close it, including an inactive tab. Closing an edited table asks whether to keep editing or discard pending changes. The final query tab stays open; blocked close actions preserve its SQL and query number. **Ctrl+W** closes the active tab; **Ctrl+Shift+T** reopens a closed tab's SQL buffer. Closed-tab history is limited to 20 entries in the current connection and is cleared on connection changes.

Right-click a tab for **Close**, **Close other tabs**, **Duplicate**, **Rename** and **Reopen closed tab**. Duplicate copies SQL into a new tab without executing it. **Ctrl+Tab** and **Ctrl+Shift+Tab** move between SQL tabs. These actions also appear in native File/Window menus. Saved connection cards include an **Edit connection** button; reopening a profile loads its metadata and leaves secrets blank.

## Editor and database tools

- Browse schemas, tables and views; collapse schemas, search objects, click a table to browse/edit rows, or inspect column types/nullability/keys.
- Use SQL tabs, syntax highlighting, engine-aware formatting, word wrap, find, open/save SQL files and restored editor buffers per connection.
- **Run / Ctrl+Enter** executes selected text, or the statement at the caret if nothing is selected. **Run script / Ctrl+Shift+Enter** runs semicolon-separated statements sequentially and keeps their separate results. Stop-on-error is enabled by default and can be changed in the Query menu.
- Use **Begin / Commit / Rollback** for explicit transactions. SQL Server uses a pinned driver transaction. Scripts are not automatically wrapped in a transaction; use explicit transaction statements when needed.
- Sort/filter the returned rows, export CSV or JSON, and restore earlier SQL from per-connection history. Display and export are limited to the returned first 1,000 rows; truncation is reported.
- Use **Database** for the real engine/version/server/user/schema and observable transaction state.
- Use **Cancel** to stop the app's database subprocess, then reconnect. For a remote server, disconnecting does not prove server-side work stopped or rolled back.
- Native File/Edit/View/Query/Database/Window/Help menus expose working actions and shortcuts. Text Explain is available for MySQL, MariaDB, PostgreSQL and SQLite.

New table prepares editable, engine-specific CREATE TABLE SQL; it executes only when you run it. Removing a saved profile keeps the database file/data.

## History, full text and resource limits

History opens as a full workspace panel. Search SQL or titles, filter success/errors and dates, favorite entries, rename titles, copy full SQL, restore into the current tab or open a new tab. Previews are labelled; the detail pane contains the complete retained SQL and scrolls without a line clamp. Delete and clear require confirmation and stay scoped to the active connection.

History defaults to 500 entries and 30 days, with configurable retention and a 2 MiB file cap. Favorites survive age expiry but remain subject to count/byte limits. Queries over 256 KiB execute normally but are not recorded. Pause capture in History to stop capture; editor autosave is separate, so use **Private query** to disable both. Redacted history requires replacing placeholders before reuse. Corrupt history is preserved read-only with an explanation.

Run the statement at the caret or selected text. **Ctrl+Space** offers lightweight keyword, cached table and current-result column completions. This is a manual local completion list, not a full SQL language server. Drag the editor divider or focus it and press Up/Down to resize. Double-click a read-only result cell, or press F2, for its full value; double-click execution status for complete details.

Table browsing offers 100/250/1,000-row pages with Previous/Next controls and pending-edit guards. Sorting/filtering applies to the current returned page. Concurrent external changes can shift OFFSET pages; reload before making decisions that require a consistent snapshot.

Queries retain at most 1,000 rows and approximately 2 MiB of serialized row payload. Server drivers drain commands after the display cap so writes with RETURNING still complete. This bounds retained display data, not server execution, network traffic, a single decoded packet/row, or total process memory. Cancel remains available. Scripts allow up to 100 statements, retain approximately 4 MiB of row payload, and label earlier results released from memory. At most four clean tab results are cached; dirty table tabs are preserved. Open tabs are capped at 30; editor storage is debounced and bounded. Disconnected database workers exit instead of staying idle. Syntax highlighting falls back to plain text above 100,000 characters.

## Edit table data

Click a table in **Database Explorer**. Double-click a cell, type a value, and press **Enter** to stage the change; **Escape** cancels that cell edit. **F2** opens an expanded editor for multiline text or SQL NULL. **Ctrl+Delete** sets a nullable cell to NULL. Empty text and NULL remain different values.

Changed cells are highlighted in amber. Use **Add row**, fill required values, or select rows and choose **Delete selected**. **Discard** removes the pending batch. **Apply changes** shows the generated SQL and bound parameters; its confirmation writes the batch in one transaction. Nothing is written merely by typing in a cell. If another connection changed a row, the batch fails and rolls back, retaining your pending edits for inspection. Discard and reload to resolve a conflict.

Editing requires a real table with a usable primary key; composite keys are supported. Existing key values, generated/identity fields, binary and unsupported typed cells are read-only. Views, tables without primary keys, and MySQL tables outside InnoDB stay read-only with an explanation. Inserts are available when required columns can be supplied or have defaults. Finish an open SQL transaction before applying grid changes. Ordinary SQL results, including joins, remain read-only; open the underlying table to edit. Table snapshots expire after 30 minutes and at most eight are retained; reload an expired tab before applying.

Pending edits survive switching tabs. Replacing results, switching connections, disconnecting, or closing an edited tab asks whether to keep editing or discard. Closing the app also asks before losing pending edits. Pending table changes are not persisted across app restarts.

## Full database backup and restore

Use **Backup** and **Restore** beside the connection name, or the Database menu. These are full database transfers, separate from the CSV/JSON export of displayed query results. The dialog identifies the actual target database, file, scope and restore warning. Backups include all rows, beyond the grid limit. Restore requires typing the exact database name (or `RESTORE` for SQLite).

| Engine | Full backup/restore behavior |
|---|---|
| SQLite | Online backup includes committed WAL data, schema, rows, indexes, views and triggers. Restore checks integrity and creates a new file, then opens it. The current database file is preserved. Import a standalone backup, not a raw live file with an active WAL/journal. |
| MySQL | Native SQL dump includes tables/data, views, triggers, routines and events. Uses a transactional export snapshot for InnoDB. Restore uses the native client, including stored-program delimiters. Server users/grants are outside database backup scope. |
| PostgreSQL | Custom archive includes schemas/data, sequences, views, indexes, functions and large objects. Restore replaces archive objects within one transaction; unrelated objects remain. Ownership becomes the connected user; cluster roles, tablespaces and grants are omitted. |
| MariaDB | Uses matching installed MariaDB clients selected in Database tools. A native 1,501-row transfer passed against MariaDB 11.4.13. |
| SQL Server | Server-side `.bak` backup/restore is not available in this local-file workflow. Querying, table editing and transaction adapters are present; live SQL Server validation remains outstanding. |

Public builds are client-free. Full MySQL/MariaDB/PostgreSQL backups require matching installed native clients, discovered from PATH/common install folders or selected in **Database tools**. SQLite transfers require no external tool. Install any runtime dependencies required by your vendor clients. No database server or user database is bundled.

Only restore trusted backups. MySQL SQL dumps execute with the connected user's privileges and may select other databases; DDL cannot be rolled back, and an error or cancellation can leave a partial restore. Back up first. Avoid concurrent schema changes during export; nontransactional MySQL tables require a maintenance window for a consistent backup. Finish any open app transaction before transferring. Cancel terminates the owned client process and disconnects the workspace; reconnect and inspect the server before retrying an interrupted restore. Transfers have a 15-minute deadline.

## Storage and development

To preserve existing installations, app data remains under the legacy `%APPDATA%\Work EZ Bench` folder after the rename: connection metadata, query history, local editor state and playground database. Ordinary SQL text is stored in history/editor state. **Private query** disables both for that tab. Pattern-based redaction removes common credential statements from history and suppresses their editor autosave; it cannot identify every secret literal. Disable capture or use Private query for sensitive SQL. Existing localStorage keys are retained for compatibility. User-selected SQLite files stay in their chosen locations. Updating or renaming the portable app preserves these files.

Run `npm.cmd test` for backend tests and `npm.cmd run test:ui` for desktop scenarios from `app`. UI tests use the pinned Playwright dependency. `npm.cmd run build:icons` regenerates the icon subset from Lucide.

## Scope and licenses

Core SQL workflows are implemented and tested; full MySQL Workbench parity is not claimed. ER modelling, migration, cloud integration, custom certificate-file selection, Windows-integrated SQL Server authentication, visual query plans, notebooks, server administration and a language-server autocomplete engine remain outside this release. Stored-procedure delimiter directives, SQL Server GO batch directives and every vendor-specific procedural script are not generally supported by the editor's script splitter. MySQL full restores use the native client and support its dump delimiters. Native query execution still uses the selected engine's own parser.

The original app source is MIT licensed. Lucide icons retain their ISC/MIT notices in ICON-LICENSE.txt. Electron/Chromium, database drivers, ssh2 and sql-formatter retain their own included licenses. Optional separately staged vendor clients retain their own licenses and source-availability obligations. Public client-free packages exclude these binaries. The app's MIT license does not relicense third-party components. Keep all included notices when redistributing.

## App updates

For a Git installation, choose **View Git update instructions** in the update dialog or follow the [Git update guide](../README.md#update-a-git-installation).

Choose **Resume SQL** in Overview to reopen your last workspace. EZ Bench restores eligible SQL drafts and preferences from its app data folder. Pending table edits need to be applied to the database. Private and credential-bearing SQL needs an explicit file save if you want to keep it. Use **File > Save SQL file** to save changes to disk.

Use **Help > Check for updates** or **Settings > Check for updates**. Checks and downloads run only when requested. Configured builds verify signed release metadata and installer hashes. Save SQL files, finish transactions, apply/discard grid changes and disconnect before **Close and install**. Windows may block unsigned setup. This build has no feed configured; the release owner must configure one before publishing update-enabled builds. Existing 0.5.0 users need a one-time manual upgrade. See [update publishing](../docs/UPDATES.md) in the source snapshot for setup and limitations.

## Current validation status

The [0.9.8 verification report](../docs/VERIFICATION-0.9.8.md) covers isolated SQLite files, real MySQL, MariaDB and PostgreSQL fixtures, an SSH test gateway, and read-only checks against public MySQL and PostgreSQL servers. SQL Server has adapter tests. Full MySQL, MariaDB and PostgreSQL transfers require matching installed vendor tools.

## Workspace actions and typography

Use the top-right **Settings** button for New connection, Open local database, Open SQL file, SQL snippets, theme switching and update checks. The menu works from Overview and connected workspaces; Escape or clicking outside dismisses it. File/Edit/View menus and existing keyboard shortcuts remain available. Overview keeps its connection/local-file actions and adds an Open SQL file shortcut. Opening a SQL file does not connect or run it; a disconnected editor is labelled Not connected.

Navigation uses proportional system text with stronger connection/table labels and small uppercase group labels. SQL uses Cascadia Code/Consolas at 14px with matching 25px editor/highlight lines. Results use 13px proportional system text, stronger column headings and tabular numbers. No font download is required; fallback fonts support the Windows target.

## Keeping the final query tab

At least one query tab remains open. Its close icon and context-menu Close action are disabled. Middle-click, Ctrl+W and File > Close SQL tab leave its SQL, name, private state and pending edits intact. An ignored close does not create another tab or advance the query number. Close others retains the chosen tab. Once another tab is open, normal close/discard safeguards apply.

## SQL snippets

Open **View > SQL snippets** or **Settings > SQL snippets**; Ctrl+Shift+J opens the library. The star button saves selected SQL, or the whole editor, as a candidate snippet. Give it a title and dialect, then choose **Save snippet**. Search titles/full SQL and filter by dialect. **Insert at caret** replaces the editor selection; **Open in new tab** creates a SQL buffer. Neither action executes SQL. Delete requires confirmation. Unsaved changes in the library are not automatically persisted.

Snippets are separate from query history and stored in local `snippets.json` as plaintext. The library keeps at most 100 snippets, 128 KiB per SQL body and 2 MiB total. Private-query capture and detected credential patterns are rejected; pattern checks cannot find every secret. Corrupt libraries are preserved and remain read-only until repaired. A saved title/dialect change retains the snippet identity.

## Database-side table filters and sorting

Open a table in Explorer and choose **Filter / sort table**. Pick one column comparison and optionally a sort column/direction. Equals, not-equal, numeric/date comparisons, literal contains/starts-with and NULL/not-NULL are available for supported types. Values are bound as parameters. LIKE wildcard characters in contains/starts-with are treated literally. Comparisons follow the database's type and collation rules; case behavior may differ by engine. Use SQL for compound predicates, arbitrary expressions and unsupported types.

Criteria run on the database across pages. The existing result search and header sort apply only to retained displayed rows. Page navigation, refresh and Apply changes retain active criteria. Reset returns to unfiltered default order. Primary keys break sort ties where available; OFFSET pages can still change under concurrent writes. Tables without keys have no stable default order. Pending edits must be applied or explicitly discarded before a filter/page change. Filter values remain in memory with the result; they are not saved as history or editor recovery.

## Find and replace

Use **Edit > Find/Replace in SQL editor**, Ctrl+F or Ctrl+H. Search is literal text, with optional Match case. Find next wraps and selects a match. Replace changes that selection; Replace all changes the current SQL buffer and shows a count. Dollar sequences remain literal, regular-expression syntax is not enabled, and replacements that would exceed the 1 MB editor limit are refused before allocating the output. SQL is never executed by replacement. Save necessary SQL explicitly; Private query still suppresses recovery.

## Keyboard shortcuts and native menus

Choose **Settings > Keyboard shortcuts**, **Help > Keyboard shortcuts** or press **F1**. Search action names or key combinations; clear the search to restore all 40 entries. The reference groups workspace, files/tabs, SQL, views, database, editor/grid, text editing and window controls. Escape closes it and restores focus. Actions that require an editor, focused cell or connection explain their scope. Shortcuts do not replace an open modal.

Useful additions: Ctrl+, opens Settings; Ctrl+Shift+N creates a connection; Ctrl+Shift+O opens a local database; Ctrl+Shift+D duplicates the current tab; Ctrl+Alt+R renames it; Ctrl+Alt+H opens Overview; Ctrl+Shift+H opens query history; Ctrl+Alt+1 returns to results; Ctrl+Alt+T switches theme. Saving/opening SQL and native backup/restore still use explicit dialogs. No destructive transfer or transaction shortcut is added.

Press Alt, then F/E/V/Q/D/W/H to navigate native Windows menus. File groups SQL files and tabs. Database groups connections/local files, explorer/table actions, backup/restore and disconnect. View groups Overview/panels, SQL library/layout, appearance and zoom. Test connection remains inside New connection, where it checks entered values without replacing the active connection.

## Sidebar layout

Overview stays at the top. Connections use their own scroll area; when connected, the database explorer gets the remaining space with its search/New table controls kept above the scrolling tree. The footer retains its existing wording and stays outside both scroll regions. All existing text is kept. Long profile/table names wrap instead of pushing controls sideways. Tree guide lines show hierarchy. The highlighted connection reflects the actual active connection, not saved metadata or an unsuccessful attempt.

Use the sidebar button or Ctrl+B to switch to the compact icon rail. Hover a profile icon for its full name/details; accessible labels remain available to screen readers. Expand again to restore the full text and explorer. The sidebar checks include many profiles/tables, dark/light minimum windows and 125% zoom. No extra background polling is added.

## Application mark

The graphite tile and two-tone database stack use the same vector source in the 34px header and the Windows icon. The Windows icon includes 16, 24, 32, 48, 64, 128 and 256px frames.
