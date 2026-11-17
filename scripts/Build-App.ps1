param([string] $OutputDirectory, [switch] $ClientFree, [string] $UpdateFeedUrl, [string] $UpdatePublicKeyPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$appRoot = Join-Path $projectRoot 'app'
$appVersion = (Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json).version
if ((Get-Content -LiteralPath (Join-Path $appRoot 'package-lock.json') -Raw | ConvertFrom-Json -AsHashtable).version -ne $appVersion) { throw 'package.json and package-lock.json versions differ.' }
$updateConfig = @{feedUrl='';publicKey='';downloadHosts=@()}
if ($UpdateFeedUrl -or $UpdatePublicKeyPath) {
    if (!$UpdateFeedUrl -or !$UpdatePublicKeyPath) { throw 'Set both UpdateFeedUrl and UpdatePublicKeyPath, or neither.' }
    $updateConfig.feedUrl = $UpdateFeedUrl
    $updateConfig.publicKey = Get-Content -LiteralPath $UpdatePublicKeyPath -Raw -Encoding utf8
}
if (!$OutputDirectory) { $OutputDirectory = Join-Path $projectRoot ('build\EZ Bench ' + $appVersion) }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output folder exists. Choose a new output directory to preserve the previous build.' }
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if(!$npmCommand -or !$nodeCommand){throw 'Install Node.js 24 LTS and npm on PATH, then retry.'}
$npmExecutable = $npmCommand.Source
$nodeExecutable = $nodeCommand.Source
$runtimeBin = Split-Path -Parent $nodeExecutable
$updateConfigJson = $updateConfig | ConvertTo-Json -Compress
$updateConfigJson | & $nodeExecutable -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(0,"utf8").replace(/^\uFEFF/,""));require(process.argv[1]).configuration(c);' (Join-Path $appRoot 'update-service.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Invalid update feed configuration.' }
$electronRoot = Join-Path $appRoot 'node_modules\electron\dist'
if (!(Test-Path -LiteralPath (Join-Path $electronRoot 'electron.exe'))) { throw 'Run npm ci and npm run setup in app/ first.' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
foreach ($item in Get-ChildItem -LiteralPath $electronRoot) {
    Copy-Item -LiteralPath $item.FullName -Destination $OutputDirectory -Recurse
}
Rename-Item -LiteralPath (Join-Path $OutputDirectory 'electron.exe') -NewName 'EZ Bench.exe'
$packageRoot = Join-Path $OutputDirectory 'resources\app'
New-Item -ItemType Directory -Path $packageRoot | Out-Null
foreach ($name in @('package.json','package-lock.json','main.cjs','preload.cjs','menu.cjs','renderer.js','workspace-menu.js','command-catalog.js','shortcuts-ui.js','update-service.cjs','update-ui.js','table-browse.cjs','table-browse-ui.js','snippet-store.cjs','snippets-ui.js','editor-search.js','editor-search-ui.js','ssh-ui.js','tab-tools.js','ssh-tunnel.cjs','table-editor.js','database-transfer-ui.js','history-store.cjs','history-ui.js','history-ui.css','sql-privacy.js','sql-text.js','editor-tools.js','result-reader.cjs','child-env.cjs','index.html','styles.css','workspace-ui.css','icons.js','theme-init.js','ICON-LICENSE.txt','database.cjs','table-edit.cjs','database-transfer.cjs','database-client.cjs','database-worker.cjs','profiles.cjs','icon.svg','icon.png','icon.ico','LICENSE','README.md')) {
    Copy-Item -LiteralPath (Join-Path $appRoot $name) -Destination $packageRoot
}
$updateConfigJson | Set-Content -LiteralPath (Join-Path $packageRoot 'update-config.json') -Encoding utf8
if(!$ClientFree -and (Test-Path -LiteralPath (Join-Path $appRoot 'vendor'))){Copy-Item -LiteralPath (Join-Path $appRoot 'vendor') -Destination $packageRoot -Recurse}
$originalPath = $env:Path
try {
    $env:Path = "$runtimeBin;$env:Path"
    Push-Location -LiteralPath $packageRoot
    try {
        & $npmExecutable ci --omit=dev --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
    } finally { Pop-Location }
} finally { $env:Path = $originalPath }
& $nodeExecutable (Join-Path $appRoot 'build-metadata.mjs') (Join-Path $OutputDirectory 'EZ Bench.exe')
if ($LASTEXITCODE -ne 0) { throw 'Executable metadata could not be set.' }
Write-Output (Join-Path $OutputDirectory 'EZ Bench.exe')
