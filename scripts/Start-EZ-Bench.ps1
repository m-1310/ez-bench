param([string] $DataDirectory)

$ErrorActionPreference = 'Stop'
$appRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'app'
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (!$npm) { throw 'Install Node.js 24 LTS for Windows and add it to PATH.' }
if (!(Test-Path -LiteralPath (Join-Path $appRoot 'node_modules\electron\dist\electron.exe'))) {
    throw 'Electron is missing. Run npm.cmd ci and npm.cmd run setup from the app folder.'
}

$arguments = @('start')
if ($DataDirectory) { $arguments += @('--', ('--data-dir=' + [IO.Path]::GetFullPath($DataDirectory))) }
Push-Location -LiteralPath $appRoot
try {
    & $npm.Source @arguments
    if ($LASTEXITCODE -ne 0) { throw ('EZ Bench exited with code ' + $LASTEXITCODE) }
} finally { Pop-Location }
