param([string] $ShortcutDirectory = [Environment]::GetFolderPath('DesktopDirectory'))

$ErrorActionPreference = 'Stop'
$appRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'app'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (!$node -or !$npm) { throw 'Install Node.js 24 LTS for Windows x64 and add it to PATH.' }

$runtime = & $node.Source -p "process.platform + '-' + process.arch + '-' + process.versions.node.split('.')[0]"
if ($LASTEXITCODE -ne 0 -or $runtime -ne 'win32-x64-24') {
    throw 'EZ Bench source installation requires Node.js 24 LTS for Windows x64.'
}
if (!$ShortcutDirectory -or !(Test-Path -LiteralPath $ShortcutDirectory -PathType Container)) {
    throw 'The desktop folder is unavailable. Pass an existing folder with -ShortcutDirectory.'
}

$electron = Join-Path $appRoot 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $appRoot 'icon.ico'
$launchArguments = '"' + $appRoot + '"'
$shortcutPath = Join-Path (Resolve-Path -LiteralPath $ShortcutDirectory).Path 'EZ Bench (Source).lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ((Test-Path -LiteralPath $shortcutPath) -and
    ($shortcut.TargetPath -ne $electron -or $shortcut.Arguments -ne $launchArguments)) {
    throw ('A different shortcut already uses this name. Rename it or choose another folder: ' + $shortcutPath)
}

Push-Location -LiteralPath $appRoot
try {
    & $npm.Source ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Close EZ Bench before reinstalling.' }
    & $npm.Source run setup
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $electron -PathType Leaf)) {
        throw 'Electron setup did not produce the pinned runtime.'
    }
} finally { Pop-Location }

$shortcut.TargetPath = $electron
$shortcut.Arguments = $launchArguments
$shortcut.WorkingDirectory = $appRoot
$shortcut.IconLocation = $icon + ',0'
$shortcut.Description = 'Launch EZ Bench from its Git checkout'
$shortcut.Save()
Write-Output ('Created ' + $shortcutPath)
