param(
    [Parameter(Mandatory=$true)][string] $InstallerPath,
    [string] $BuildDirectory
)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$InstallerPath=[IO.Path]::GetFullPath($InstallerPath)
if(!(Test-Path -LiteralPath $InstallerPath)){throw 'Choose an existing setup executable.'}
if($BuildDirectory){$BuildDirectory=[IO.Path]::GetFullPath($BuildDirectory)}
$zipCommand=Get-Command 7z.exe -ErrorAction SilentlyContinue
$zipExe=if($zipCommand){$zipCommand.Source}else{'C:\Program Files\7-Zip\7z.exe'}
if(!(Test-Path -LiteralPath $zipExe)){throw '7-Zip is required for static installer verification.'}
$fixtureRoot=[IO.Path]::GetFullPath((Join-Path $projectRoot ('target\installer-static-'+[guid]::NewGuid().ToString('N'))))
$allowedRoot=[IO.Path]::GetFullPath((Join-Path $projectRoot 'target'))+[IO.Path]::DirectorySeparatorChar
if(!$fixtureRoot.StartsWith($allowedRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Static verification must stay inside this project target directory.'}
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
& $zipExe t $InstallerPath -bsp0 -bso0
if($LASTEXITCODE -ne 0){throw 'Installer archive integrity check failed.'}
& $zipExe x $InstallerPath ('-o'+$fixtureRoot) -y -bsp0 -bso0
if($LASTEXITCODE -ne 0){throw 'Installer static payload extraction failed.'}
$manifestPath=Join-Path $fixtureRoot '.ez-bench-files.json'
if(!(Test-Path -LiteralPath $manifestPath)){throw 'Installed-payload manifest is missing from setup.'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$files=@($manifest.files)
foreach($file in $files){
    $relative=$file.path
    if([IO.Path]::IsPathRooted($relative) -or ($relative.Split('/') -contains '..')){throw 'Invalid manifest payload path.'}
    $candidate=[IO.Path]::GetFullPath((Join-Path $fixtureRoot $relative))
    if(!$candidate.StartsWith($fixtureRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Payload path escaped the verification directory.'}
    if(!(Test-Path -LiteralPath $candidate) -or (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLower() -ne $file.sha256){throw ('Extracted payload hash mismatch: '+$relative)}
    if($BuildDirectory){
        $source=Join-Path $BuildDirectory $relative
        if(!(Test-Path -LiteralPath $source) -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLower() -ne $file.sha256){throw ('Installer differs from validated portable build: '+$relative)}
    }
}
$result=[pscustomobject]@{operation='static_installer_verification';product=$manifest.product;version=$manifest.version;installer=[IO.Path]::GetFileName($InstallerPath);sha256=(Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLower();payloadFiles=$files.Count;payloadHashesMatched=$true;portableBuildCompared=[bool]$BuildDirectory;containsVendorExecutables=[bool]($files | Where-Object {$_.path -match '^resources/app/vendor/.*\.exe$'});archiveIntegrity='passed';installerExecuted=$false;passed=$true;fixtureRoot=$fixtureRoot}
$result|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $fixtureRoot 'validation.json') -Encoding utf8
$result|ConvertTo-Json -Depth 4
