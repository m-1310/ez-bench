param([string] $OutputDirectory)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$version=(Get-Content -LiteralPath (Join-Path $projectRoot 'app\package.json') -Raw | ConvertFrom-Json).version
if(!$OutputDirectory){$OutputDirectory=Join-Path $projectRoot ('releases\'+$version+'\EZ-Bench-Source-'+$version+'-GitHub')}
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
if($OutputDirectory -eq $projectRoot -or $OutputDirectory.StartsWith((Join-Path $projectRoot 'app')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Choose a separate output folder, not the project or app source folder.'}
if(Test-Path -LiteralPath $OutputDirectory){throw 'Source output folder exists. Preserve it and choose another destination.'}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
function Copy-PublicFile([string] $Relative) {
    $source=Join-Path $projectRoot $Relative
    if(!(Test-Path -LiteralPath $source -PathType Leaf)){return}
    $target=Join-Path $OutputDirectory $Relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
}
# Explicit allowlist: no recursive copy of this working tree or its private evidence.
Copy-PublicFile '.gitignore'
Copy-PublicFile '.gitattributes'
Copy-PublicFile 'README.md'
Copy-PublicFile 'SECURITY.md'
Copy-Item -LiteralPath (Join-Path $projectRoot 'app\LICENSE') -Destination (Join-Path $OutputDirectory 'LICENSE')
$excludedTests=@('live-ui.test.cjs','live-edit-transfer-ui.test.cjs','ssh-live-ui.test.cjs')
foreach($file in Get-ChildItem -LiteralPath (Join-Path $projectRoot 'app') -File){
    if($file.Name -in $excludedTests){continue}
    if($file.Extension -in @('.js','.cjs','.mjs','.css','.html') -or $file.Name -in @('package.json','package-lock.json','README.md','LICENSE','ICON-LICENSE.txt','icon.svg','icon.png','icon.ico','update-config.json')){Copy-PublicFile ('app\'+$file.Name)}
}
foreach($name in @('Build-App.ps1','Clean-Artifacts.ps1','Test-Cleanup.ps1','Build-Release.ps1','update-release.cjs','Build-Installer.ps1','Package-App.ps1','Prepare-GitHub.ps1','Start-EZ-Bench.ps1','Start-Work-EZ-Bench.ps1','measure-runtime.cjs')){Copy-PublicFile ('scripts\'+$name)}
foreach($name in @('EZ-Bench.nsi','Test-Installer.ps1','Verify-Installer.ps1')){Copy-PublicFile ('installer\'+$name)}
foreach($name in @('UPDATES.md','RELEASING.md','VERIFICATION-0.9.8.md','THIRD-PARTY-DATABASE-TOOLS.md')){Copy-PublicFile ('docs\'+$name)}
foreach($name in @('workspace-overview.png','sql-editor-and-results.png')){Copy-PublicFile ('docs\screenshots\'+$name)}
foreach($file in Get-ChildItem -LiteralPath (Join-Path $projectRoot '.github\workflows') -File -ErrorAction SilentlyContinue){Copy-PublicFile ('.github\workflows\'+$file.Name)}

# Test-only live fixture tests are not part of the public source snapshot. The
# self-contained unit and desktop tests remain reproducible without DB credentials.
$packagePath=Join-Path $OutputDirectory 'app\package.json'
$package=Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
if ($package.scripts.PSObject.Properties['test:live-ui']) {
    $package.scripts.PSObject.Properties.Remove('test:live-ui')
    $package | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $packagePath -Encoding utf8
}
$excluded=[pscustomobject]@{version=$version;clientFree=$true;excludedDirectories=@('.git','target','build','releases','evidence','graphify-out','node_modules','app/vendor/database-tools');excludedLiveFixtureTests=$excludedTests;excludedPatterns=@('.env*','private-key files','database files','profiles.json','history.json','snippets.json');note='Only independent source, selected current documentation and self-contained tests are copied. No publication or GitHub push is performed.'}
$excluded | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'SOURCE-EXCLUSIONS.json') -Encoding utf8

$findings=[Collections.Generic.List[string]]::new()
foreach($file in Get-ChildItem -LiteralPath $OutputDirectory -Recurse -File){
    if($file.Extension -notin @('.js','.cjs','.mjs','.html','.css','.json','.md','.txt','.ps1','.nsi','.yml','.yaml')){continue}
    $text=Get-Content -LiteralPath $file.FullName -Raw
    if($text -match '(?i)[A-Z]:[\\/]+Users[\\/]+(?!Public[\\/]|Default[\\/])[^\\/\s]+[\\/]'){$findings.Add('Personal Windows profile path: '+$file.FullName.Substring($OutputDirectory.Length+1))}
    if($text -match '-----BEGIN (?:OPENSSH|RSA|EC|DSA|ENCRYPTED)? ?PRIVATE KEY-----'){$findings.Add('Private-key material: '+$file.FullName.Substring($OutputDirectory.Length+1))}
    if($text -match '\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}|\bAKIA[0-9A-Z]{16}\b'){$findings.Add('High-signal credential token: '+$file.FullName.Substring($OutputDirectory.Length+1))}
    if($text -match 'WorkEzFixture-(?:Root|Only)-2026!'){$findings.Add('Local DB fixture credential: '+$file.FullName.Substring($OutputDirectory.Length+1))}
}
if($findings.Count){throw ('Public source scan found data that needs review: '+($findings -join '; '))}
$manifest=@(Get-ChildItem -LiteralPath $OutputDirectory -Recurse -File | Sort-Object FullName | ForEach-Object {[pscustomobject]@{path=$_.FullName.Substring($OutputDirectory.Length+1).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()}})
[pscustomobject]@{product='EZ Bench';version=$version;files=$manifest;scan=[pscustomobject]@{personalProfilePaths=0;privateKeyBlocks=0;highSignalTokens=0;fixtureAdminCredentials=0}} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'SOURCE-MANIFEST.json') -Encoding utf8
$archive=$OutputDirectory+'.zip'
if(Test-Path -LiteralPath $archive){throw 'Source archive already exists; choose another output destination.'}
Compress-Archive -LiteralPath $OutputDirectory -DestinationPath $archive -CompressionLevel Optimal
$digest=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower()
($digest+' *'+[IO.Path]::GetFileName($archive)) | Set-Content -LiteralPath ($archive+'.sha256') -Encoding ascii
[pscustomobject]@{sourceDirectory=$OutputDirectory;archive=$archive;sha256=$digest;files=$manifest.Count+1;bytes=(Get-Item -LiteralPath $archive).Length;findings=0;published=$false}|ConvertTo-Json
