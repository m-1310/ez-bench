param(
    [string] $OutputDirectory,
    [string] $UpdateFeedUrl,
    [string] $UpdatePublicKeyPath,
    [string] $InstallerUrl,
    [string] $UpdatePrivateKeyPath
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$appRoot = Join-Path $projectRoot 'app'
$version = (Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json).version
if (!$OutputDirectory) { $OutputDirectory = Join-Path $projectRoot ('build\EZ Bench ' + $version) }
$releases = Join-Path $projectRoot ('releases\' + $version)
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if(!$nodeCommand -or !$npmCommand){throw 'Install Node.js 24 LTS and npm on PATH, then retry.'}
$nodeExecutable = $nodeCommand.Source
$npmExecutable = $npmCommand.Source
$configured = [bool]($UpdateFeedUrl -or $UpdatePublicKeyPath -or $InstallerUrl -or $UpdatePrivateKeyPath)
if ($configured) {
    if (!$UpdateFeedUrl -or !$UpdatePublicKeyPath -or !$InstallerUrl -or !$UpdatePrivateKeyPath) { throw 'For updates, set all four feed, public-key, installer-URL and private-key options.' }
    # Fail before building if the release signer differs from the trusted build key.
    & $nodeExecutable -e 'const fs=require("node:fs"),c=require("node:crypto");const a=c.createPublicKey(fs.readFileSync(process.argv[1])).export({type:"spki",format:"der"});const b=c.createPublicKey(c.createPrivateKey(fs.readFileSync(process.argv[2]))).export({type:"spki",format:"der"});if(!a.equals(b))throw Error("Release signing keys do not match");' $UpdatePublicKeyPath $UpdatePrivateKeyPath
    if ($LASTEXITCODE -ne 0) { throw 'Release key validation failed.' }
}
foreach ($candidate in @($OutputDirectory, (Join-Path $releases ('EZ-Bench-'+$version+'-win-x64.zip')), (Join-Path $releases ('EZ-Bench-Setup-'+$version+'.exe')), (Join-Path $releases ('EZ-Bench-Source-'+$version+'-GitHub')), (Join-Path $releases ('EZ-Bench-Source-'+$version+'-GitHub.zip')), (Join-Path $releases ('update-'+$version+'.json')))) {
    if(Test-Path -LiteralPath $candidate){throw ('Release output already exists; preserve it and choose a new version/output: '+$candidate)}
}
& (Join-Path $PSScriptRoot 'Test-Cleanup.ps1')
$originalPath = $env:Path
try {
    $env:Path = (Split-Path -Parent $nodeExecutable) + ';' + $env:Path
    Push-Location -LiteralPath $appRoot
    try {
        & $npmExecutable ci
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
        & $npmExecutable run setup
        if ($LASTEXITCODE -ne 0) { throw 'Electron setup failed.' }
        & $npmExecutable test
        if ($LASTEXITCODE -ne 0) { throw 'Backend tests failed.' }
        & $npmExecutable run test:ui
        if ($LASTEXITCODE -ne 0) { throw 'Desktop tests failed.' }
        & $npmExecutable audit --omit=dev
        if ($LASTEXITCODE -ne 0) { throw 'Production dependency audit failed.' }
    } finally { Pop-Location }
    & (Join-Path $PSScriptRoot 'Build-App.ps1') -OutputDirectory $OutputDirectory -ClientFree -UpdateFeedUrl $UpdateFeedUrl -UpdatePublicKeyPath $UpdatePublicKeyPath
    # Verify the actual packaged application, not only the development tree.
    $previousExecutable = $env:WORK_EZ_BENCH_EXECUTABLE
    try {
        $env:WORK_EZ_BENCH_EXECUTABLE = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'EZ Bench.exe'
        Push-Location -LiteralPath $appRoot
        try { & $npmExecutable run test:ui; if ($LASTEXITCODE -ne 0) { throw 'Packaged desktop tests failed.' } } finally { Pop-Location }
    } finally { $env:WORK_EZ_BENCH_EXECUTABLE = $previousExecutable }
    & (Join-Path $PSScriptRoot 'Package-App.ps1') -BuildDirectory $OutputDirectory
    & (Join-Path $PSScriptRoot 'Build-Installer.ps1') -BuildDirectory $OutputDirectory
    $installer = Join-Path $releases ('EZ-Bench-Setup-'+$version+'.exe')
    & (Join-Path $projectRoot 'installer\Verify-Installer.ps1') -InstallerPath $installer -BuildDirectory $OutputDirectory
    if ($configured) {
        & $nodeExecutable (Join-Path $PSScriptRoot 'update-release.cjs') manifest $installer $InstallerUrl $UpdatePrivateKeyPath $version (Join-Path $releases ('update-'+$version+'.json'))
        if ($LASTEXITCODE -ne 0) { throw 'Signed update manifest generation failed.' }
    }
    & (Join-Path $PSScriptRoot 'Prepare-GitHub.ps1') -OutputDirectory (Join-Path $releases ('EZ-Bench-Source-'+$version+'-GitHub'))
} finally { $env:Path = $originalPath }
Write-Output 'Release prepared locally. Review before publishing. Installer execution and Windows 10 testing require a permitted test machine.'
