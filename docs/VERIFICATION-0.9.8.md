# EZ Bench 0.9.8 verification

Validated on November 17, 2026, on Windows 11 x64. The setup file is `EZ-Bench-Setup-0.9.8.exe`. The release folder includes its SHA-256 checksum.

| Area | Result |
| --- | --- |
| Backend | 104 tests passed. Coverage includes connection validation, worker lifecycle, schema and table browsing, transfers, bounded results, credential handling, history and signed update verification. |
| Desktop | 21 development-runtime scenarios passed. They exercise the SQL editor, tabs, scripts, SQLite files, result sorting and export, grid edits, history and private queries, snippets, menus, shortcuts, themes and sidebar. |
| Live database desktop | Six scenarios passed against real MySQL 8.4.13 and PostgreSQL 18.6. They cover connections, SQL, transactions, schema browsing, grid edits and native transfers directly or through an isolated SSH gateway. |
| MariaDB | MariaDB 11.4.13 passed SQL and rollback, grid editing, a 1,501-row native backup and restore, verified TLS, and TLS over SSH with an encrypted key. |
| Internet connectivity | The packaged worker modules connected to the public Ensembl MySQL and RNAcentral PostgreSQL services on their documented ports and returned `SELECT 1`. Their tested public sessions used TLS off. [Ensembl connection details](https://useast.ensembl.org/info/data/mysql.html) and [RNAcentral connection details](https://www.rnacentral.org/help/public-database). |
| TLS | 12 MySQL and PostgreSQL fixture checks passed. Both negotiated TLS directly and over SSH and rejected invalid identities and untrusted issuers. MySQL and MariaDB now require the certificate hostname when TLS is selected. |
| SQL Server | Adapter tests passed. A live SQL Server instance was unavailable. |
| Branding | Inspected the 34px header mark in both themes and the Windows icon resources in the packaged app and installer. The ICO includes seven sizes from 16px through 256px. |
| Package integrity | The setup archive and all 8,845 file hashes matched the build. The full npm dependency audit reported zero known vulnerabilities. |
| Installation | Windows Application Control blocked the unsigned packaged app and the setup smoke test. Installation, upgrade, uninstall and Windows 10 execution remain unverified. |

The update verification tests use test releases. The installer ships without a configured update feed. Full MySQL, MariaDB and PostgreSQL backup and restore require their corresponding native client tools. SQLite transfers work with the included runtime.

To connect from another computer, install on a Windows x64 system whose policy permits the build. Open **New connection**, enter the database host, port and credentials, and select **Test connection**. The target server must be reachable from that computer. For MySQL and MariaDB TLS, use the hostname from the certificate in **Host**.
