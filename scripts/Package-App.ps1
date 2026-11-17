param([string] $BuildDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'app\package.json') -Raw | ConvertFrom-Json).version
if (!$BuildDirectory) { $BuildDirectory = Join-Path $projectRoot ('build\EZ Bench ' + $version) }
$BuildDirectory = [IO.Path]::GetFullPath($BuildDirectory)
$executable = Join-Path $BuildDirectory 'EZ Bench.exe'
if (!(Test-Path -LiteralPath $executable)) { throw 'Build and test the application before packaging it.' }
$payloadVersion = (Get-Content -LiteralPath (Join-Path $BuildDirectory 'resources\app\package.json') -Raw | ConvertFrom-Json).version
if ($payloadVersion -ne $version) { throw 'Portable build version differs from app/package.json. Rebuild before packaging.' }
$releases = Join-Path $projectRoot ('releases\' + $version)
New-Item -ItemType Directory -Path $releases -Force | Out-Null
$archive = Join-Path $releases ('EZ-Bench-' + $version + '-win-x64.zip')
if (Test-Path -LiteralPath $archive) { throw 'The release archive already exists. Preserve it and choose a new version.' }
$readme = @"
EZ BENCH $version - PORTABLE WINDOWS APP

Requires Windows 10 or later, x64. Windows 7/8 and 32-bit Windows are unsupported.

Extract the complete ZIP, then open EZ Bench.exe in its folder.
Keep the executable and supporting files together. Node.js is not required.

Choose New connection for MySQL, MariaDB, PostgreSQL or SQL Server.
Choose Open local DB / Create database for SQLite, or try Open playground.
The app is a client and does not install database servers.
Connection passwords are not saved. Ordinary SQL/editor history stays in local
app data. Use Private query for sensitive SQL to disable history and autosave.

Native menus: File / Edit / View / Query / Database / Window / Help.
Ctrl+Enter runs selected text or the statement at the caret; Ctrl+Shift+Enter runs a script.
Begin, Commit and Rollback control explicit database transactions.
Cancel disconnects the app's database subprocess; reconnect to continue.
Graphite/copper is the default, with warm ivory text and ice-blue details.
Light mode uses warm paper surfaces.
Settings contains appearance, connection/file, snippet and update actions.
Overview also opens SQL files. The theme action switches dark/light modes. Homepage patterns are static; SQL surfaces stay plain.
There are no tour or release-notes screens.
View > SQL snippets opens the reusable local SQL library. Saving never runs SQL.
Filter / sort table runs on the database across pages; result search is display-only.
Edit > Replace supports literal text replacements without executing the SQL.

SSH: enable Connect through an SSH tunnel in New connection. Database and SSH
logins are separate. Verify the SHA256 host fingerprint before trusting it.
Password and encrypted OpenSSH/PEM private-key authentication are supported.
SSH passwords/passphrases are never saved. Database Host is reached from SSH.
Middle-click closes tabs. Right-click offers duplicate, rename and close others.
Ctrl+Shift+T reopens closed tabs. Ctrl+Tab / Ctrl+Shift+Tab cycle tabs.

Click an Explorer table, double-click a cell, then Enter to stage an edit.
Apply changes previews SQL and confirms an atomic batch. Add/delete rows and
Discard are available. Primary keys are required; SQL query results are read-only.
Backup / Restore transfer complete SQLite, MySQL, MariaDB and PostgreSQL databases.
SQLite restore creates a new file. MySQL restore may partially apply on error.
Public builds are client-free. Select installed matching native client tools in
Database tools for MySQL/MariaDB/PostgreSQL full backup and restore.
SQLite transfers require no external client. No database servers are included.

Supported engines and verification details are in resources\app\README.md.
Live MariaDB server workflows and MySQL and PostgreSQL desktop workflows were tested.
SQL Server has adapter-level coverage.
ER modelling, migration and advanced server administration are not in this release.

App data stays in legacy %APPDATA%\Work EZ Bench after the rename.
Replacing this application folder preserves profiles, history and databases.
Original application code: MIT. Third-party and icon licenses remain included.
Optional vendor database clients retain their own licenses and source obligations.
"@
$readme | Set-Content -LiteralPath (Join-Path $BuildDirectory 'READ-ME.txt') -Encoding utf8
$zipCommand = Get-Command 7z.exe -ErrorAction SilentlyContinue
$zipExe = if($zipCommand){$zipCommand.Source}else{'C:\Program Files\7-Zip\7z.exe'}
if (!(Test-Path -LiteralPath $zipExe)) { throw '7-Zip is required by this local packaging script.' }
Push-Location -LiteralPath (Split-Path -Parent $BuildDirectory)
try { & $zipExe a -tzip $archive (Split-Path -Leaf $BuildDirectory) -mx=5 -bsp0; if ($LASTEXITCODE -ne 0) { throw 'ZIP creation failed.' } }
finally { Pop-Location }
$digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower()
($digest + ' *' + (Split-Path -Leaf $archive)) | Set-Content -LiteralPath ($archive + '.sha256') -Encoding ascii
[pscustomobject]@{version=$version;executable=$executable;archive=$archive;sha256=$digest;bytes=(Get-Item -LiteralPath $archive).Length} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $releases ('release-' + $version + '.json')) -Encoding utf8
Write-Output $archive
