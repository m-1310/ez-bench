param([Parameter(Mandatory=$true)][string] $InstallerPath)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$InstallerPath=[IO.Path]::GetFullPath($InstallerPath)
if(!(Test-Path -LiteralPath $InstallerPath)){throw 'Choose an existing built installer.'}
$fixtureRoot=Join-Path $projectRoot ('target\installer-validation-'+[guid]::NewGuid().ToString('N'))
$fixtureRoot=[IO.Path]::GetFullPath($fixtureRoot)
$allowedRoot=[IO.Path]::GetFullPath((Join-Path $projectRoot 'target'))+[IO.Path]::DirectorySeparatorChar
if(!$fixtureRoot.StartsWith($allowedRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Installer validation must stay inside this project target directory.'}
$installRoot=Join-Path $fixtureRoot 'program'
$dataRoot=Join-Path $fixtureRoot 'user-data'
$foreignRoot=Join-Path $fixtureRoot 'foreign'
New-Item -ItemType Directory -Path $dataRoot,$foreignRoot -Force | Out-Null
$sentinel=Join-Path $dataRoot 'history.json'
Set-Content -LiteralPath $sentinel -Value '{"test":"preserve user data"}' -Encoding utf8
$sentinelHash=(Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
$foreignFile=Join-Path $foreignRoot 'keep.txt'
Set-Content -LiteralPath $foreignFile -Value 'Unrelated files must be preserved.' -Encoding utf8
$checks=[Collections.Generic.List[string]]::new()
function Invoke-Setup([string] $Destination) {
    $process=Start-Process -FilePath $InstallerPath -ArgumentList @('/S','/TESTMODE',('/D='+$Destination)) -WindowStyle Hidden -Wait -PassThru
    return $process.ExitCode
}
$foreignExit=Invoke-Setup $foreignRoot
if($foreignExit -eq 0 -or !(Test-Path -LiteralPath $foreignFile) -or (Test-Path -LiteralPath (Join-Path $foreignRoot 'EZ Bench.exe'))){throw 'Installer did not refuse the unrelated nonempty destination.'}
$checks.Add('Nonempty unrelated destination rejected without modifying files')
if((Invoke-Setup $installRoot) -ne 0){throw 'Silent per-user fixture installation failed.'}
$appExe=Join-Path $installRoot 'EZ Bench.exe'
$uninstaller=Join-Path $installRoot 'Uninstall.exe'
$marker=Join-Path $installRoot '.ez-bench-install.ini'
$manifestPath=Join-Path $installRoot '.ez-bench-files.json'
foreach($file in @($appExe,$uninstaller,$marker,$manifestPath)){if(!(Test-Path -LiteralPath $file)){throw ('Missing installed file: '+$file)}}
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach($file in $manifest.files){
    $candidate=[IO.Path]::GetFullPath((Join-Path $installRoot $file.path))
    if(!$candidate.StartsWith($installRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Manifest escaped the installation root.'}
    if((Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLower() -ne $file.sha256){throw ('Installed payload hash mismatch: '+$file.path)}
}
$checks.Add('Silent isolated installation succeeded and every installed payload hash matched')
$unknown=Join-Path $installRoot 'user-created-note.txt'
Set-Content -LiteralPath $unknown -Value 'Not owned by installer.' -Encoding utf8
if((Invoke-Setup $installRoot) -ne 0){throw 'Fixture reinstall/update failed.'}
if(!(Test-Path -LiteralPath $unknown) -or (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash){throw 'Reinstall changed unknown files or simulated user data.'}
$checks.Add('Reinstall/update preserved application data and unknown installation files')
$process=Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
if($process.ExitCode -ne 0){throw ('Silent fixture uninstall failed: '+$process.ExitCode)}
$deadline=[DateTime]::UtcNow.AddSeconds(30)
while((Test-Path -LiteralPath $appExe) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
if((Test-Path -LiteralPath $appExe) -or (Test-Path -LiteralPath $marker)){throw 'Uninstall left owned program/marker files behind.'}
if(!(Test-Path -LiteralPath $unknown) -or !(Test-Path -LiteralPath $foreignFile) -or (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $sentinelHash){throw 'Uninstall removed unknown files, unrelated files or simulated user data.'}
$checks.Add('Uninstall removed owned program files while preserving unknown files and user data')
$result=[pscustomobject]@{date=[DateTime]::UtcNow.ToString('o');installer=[IO.Path]::GetFileName($InstallerPath);sha256=(Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLower();fixtureOnly=$true;testModeNoShortcutsOrRegistry=$true;installedPayloadFiles=$manifest.files.Count;checks=$checks;passed=$true;fixtureRoot=$fixtureRoot}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $fixtureRoot 'validation.json') -Encoding utf8
$result | ConvertTo-Json -Depth 5
