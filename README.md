# EZ Bench

EZ Bench is a Windows desktop SQL client for MySQL, MariaDB, PostgreSQL, SQL Server, and SQLite. It includes a SQL editor, editable tables, query history, snippets, and SSH tunnelling.

## Run from a fresh clone

Install [Node.js 24 LTS](https://nodejs.org/en/download) for Windows x64. Open PowerShell and run:

```powershell
git clone https://github.com/m-1310/ez-bench.git
Set-Location ez-bench\app
npm.cmd ci
npm.cmd run setup
npm.cmd start
```

`npm.cmd ci` installs the pinned dependencies. `npm.cmd run setup` ensures Electron is available. On later launches, run `npm.cmd start` from `app` or `./scripts/Start-EZ-Bench.ps1` from the repository root.

Choose **Open playground** to start with a local SQLite database. For a remote database, choose **New connection**, enter the host, port, and credentials, then select **Test connection**. Use the certificate hostname for MySQL or MariaDB when TLS is enabled. See the [user guide](app/README.md) for SSH and backup options.

## Test

From `app`, with dependencies and Electron installed, run:

```powershell
npm.cmd test
npm.cmd run test:ui
```

The test suites use isolated app data and local fixtures. They require no database account, signing key, or configured update feed. See the [0.9.8 verification report](docs/VERIFICATION-0.9.8.md) for engine coverage and remaining checks.

## Build on Windows

The repository contains source and assets. Follow the [build instructions](docs/RELEASING.md) to create a portable ZIP or Windows setup locally. Generated executables, vendor binaries, and release archives are kept out of Git.

## Contribute

Create a branch or fork, run the tests, and open a pull request against `main` for the repository owner to merge. Include source files, tests, and documentation. Keep connection profiles, private keys, environment files, and database exports local. See [security and privacy](SECURITY.md).

EZ Bench is [MIT licensed](LICENSE). Dependency and icon notices are included with the app.
