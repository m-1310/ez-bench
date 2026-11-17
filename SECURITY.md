# Security and privacy

EZ Bench runs as a local SQL client. It does not require an account or install a database server, background service, scheduled task, startup entry or telemetry agent.

## Credentials and local data

Connection profiles retain endpoint metadata and trusted SSH fingerprints. Database passwords, SSH passwords, private-key contents and key passphrases are not saved in profiles. Credentials are held in process memory while a connection is open. SSH private keys are read only from the path selected by the user. This is not a claim that JavaScript memory can be securely erased or protected against a compromised computer.

Query history and editor recovery can contain SQL text. SQL literals may contain personal data or application secrets. Use history privacy controls, delete unwanted records and inspect app data before sharing it. Redaction reduces known secret patterns but cannot identify every possible secret or sensitive literal.

The compatibility data folder is `%APPDATA%\Work EZ Bench`. User-selected databases and backups remain at the chosen paths. Uninstalling the app preserves these locations; remove them yourself only after backing up data you need. Do not commit this folder, database files, backups, `.env` files or private keys to GitHub.

## Connections and SQL execution

SSH host keys require explicit SHA256 verification. Unknown or changed keys do not silently authenticate. Database TLS verification remains separate from SSH. Do not bypass certificate or host-key failures. An unexpected transport failure is not automatically retried for writes.

Only run SQL and restore backups from trusted sources. SQL executes with the connected account's privileges. MySQL DDL and dump restore can commit changes before an error; backup first. The app is not a SQL sandbox, and parameterized grid editing does not make arbitrary user-entered SQL safe.

## Public releases

The public source preparation script uses an explicit allowlist. It excludes captured reverse-engineering evidence, original Oracle artifacts, server fixtures, private keys, local app data, dependency folders and vendor client binaries. It checks for personal Windows profile paths, private-key blocks and high-signal token formats. This check is bounded and does not prove that all possible secrets are absent; review the staged manifest and source before publication.

Public installers default to a client-free app build. Install/select matching vendor tools for full server backup/restore. Redistributing vendor binaries has separate license and corresponding-source requirements; the app's MIT license does not replace those terms.

Setup executables are unsigned unless a release owner adds their own signing step. Operating-system Application Control can block unsigned setup files. Do not bypass organizational security controls. A successful compiler/static payload check is not proof that setup executed successfully on a locked-down computer.

Report vulnerabilities privately to the repository owner through a private security advisory when the repository enables that feature. Do not include real credentials, personal database contents or private keys in a public issue. Provide a minimal fixture and steps to reproduce instead.

## Application updates

Update checks are manual and disabled until the release owner configures an HTTPS feed and Ed25519 public key. Every offered executable is bound to signed product/platform/version/OS/size/SHA-256 metadata. Redirects remain HTTPS and within configured hosts. Only newer stable versions are offered; bytes are rechecked immediately before handing setup to Windows. The signing private key must remain outside source and releases. A signed manifest is not Windows Authenticode trust. Installer execution respects Windows policy. See [update details](docs/UPDATES.md).

## Saved snippets and table filters

Named SQL snippets are local plaintext, independent of query history. Explicitly save only reusable SQL without secrets. Private capture and detected credential patterns are rejected, but pattern detection is incomplete. Atomic writes preserve the previous library on failure; invalid libraries remain read-only and untouched. Public source preparation excludes actual user snippet stores.

Database-side table filter values use bound parameters. Operators, directions and column names are checked against fixed choices and inspected metadata. Filter state is not added to history/editor recovery. Like any SQL predicate, filtering can still cause server scans, network work and engine errors; it does not bound server work or establish row-level access control.
