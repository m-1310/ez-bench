param(
    [string] $BuildDirectory,
    [string] $CompilerPath,
    [string] $OutputPath,
    [switch] $AllowVendorTools
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$appRoot = Join-Path $projectRoot 'app'
$version = (Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json).version
if (!$BuildDirectory) { $BuildDirectory = Join-Path $projectRoot ('build\EZ Bench ' + $version) }
$BuildDirectory = [IO.Path]::GetFullPath($BuildDirectory)
if (!(Test-Path -LiteralPath (Join-Path $BuildDirectory 'EZ Bench.exe'))) { throw 'Build and validate the app before creating the installer.' }
$payloadVersion = (Get-Content -LiteralPath (Join-Path $BuildDirectory 'resources\app\package.json') -Raw | ConvertFrom-Json).version
if ($payloadVersion -ne $version) { throw 'Portable build version differs from app/package.json. Rebuild before packaging.' }
if (!$OutputPath) { $OutputPath = Join-Path $projectRoot ('releases\' + $version + '\EZ-Bench-Setup-' + $version + '.exe') }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $OutputPath) { throw 'Installer output exists; preserve it or choose a new output name.' }
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
$vendorRoot = Join-Path $BuildDirectory 'resources\app\vendor\database-tools'
if (!$AllowVendorTools -and (Get-ChildItem -LiteralPath $vendorRoot -Recurse -File -Filter '*.exe' -ErrorAction SilentlyContinue)) {
    throw 'Public installers default to a client-free build. Rebuild with -ClientFree, or use -AllowVendorTools only after satisfying every vendor redistribution/source obligation.'
}

$compilerVersion = '3.13'
$compilerHash = 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8'
$compilerUrl = 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13.zip'
$toolRoot = Join-Path $projectRoot 'target\installer-tools'
if (!$CompilerPath) {
    $CompilerPath = Join-Path $toolRoot ('nsis-' + $compilerVersion + '\makensis.exe')
    New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
    $archive = Join-Path $toolRoot ('nsis-' + $compilerVersion + '-download.zip')
    if (!(Test-Path -LiteralPath $archive)) {
        & curl.exe --fail --location --retry 2 --max-time 120 --output $archive $compilerUrl
        if ($LASTEXITCODE -ne 0) { throw 'Official NSIS compiler download failed.' }
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower() -ne $compilerHash) { throw 'NSIS archive SHA-256 did not match the publisher hash. The compiler was not extracted or run.' }
    if (!(Test-Path -LiteralPath $CompilerPath)) {
        Expand-Archive -LiteralPath $archive -DestinationPath $toolRoot
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip=[IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach($entry in $zip.Entries){
            if(!$entry.Name){continue}
            $candidate=[IO.Path]::GetFullPath((Join-Path $toolRoot $entry.FullName))
            if(!$candidate.StartsWith([IO.Path]::GetFullPath($toolRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Compiler archive path escaped the tool directory.'}
            if(!(Test-Path -LiteralPath $candidate)){throw ('Compiler distribution member is missing: '+$entry.FullName)}
            $stream=$entry.Open();$sha=[Security.Cryptography.SHA256]::Create()
            try{$expected=[Convert]::ToHexString($sha.ComputeHash($stream)).ToLower()}finally{$stream.Dispose();$sha.Dispose()}
            if((Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLower() -ne $expected){throw ('Compiler distribution member differs from the verified archive: '+$entry.FullName)}
        }
    } finally {$zip.Dispose()}
}
$CompilerPath = [IO.Path]::GetFullPath($CompilerPath)
if (!(Test-Path -LiteralPath $CompilerPath)) { throw 'The selected NSIS compiler does not exist.' }
$compilerReported = (& $CompilerPath /VERSION | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $compilerReported -notmatch '^v3\.(?:1[3-9]|[2-9][0-9])(?:\D|$)') { throw ('Use NSIS 3.13 or newer; selected compiler reported ' + $compilerReported) }

$workRoot = Join-Path $projectRoot ('target\installer-build\' + $version + '-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
function ConvertTo-NsisLiteral([string] $Value) { return $Value.Replace('$','$$').Replace('"','$\"') }
$files = @(Get-ChildItem -LiteralPath $BuildDirectory -Recurse -File | Sort-Object FullName)
$payloadLines = [Collections.Generic.List[string]]::new()
$uninstallLines = [Collections.Generic.List[string]]::new()
$manifest = [Collections.Generic.List[object]]::new()
$previousDirectory = $null
foreach ($file in $files) {
    $relative = $file.FullName.Substring($BuildDirectory.Length + 1)
    if ([IO.Path]::IsPathRooted($relative) -or ($relative.Split('\') -contains '..')) { throw 'Invalid relative payload path.' }
    $directory = Split-Path -Parent $relative
    if ($directory -ne $previousDirectory) {
        $suffix = if ($directory) { '\' + (ConvertTo-NsisLiteral $directory) } else { '' }
        $payloadLines.Add('SetOutPath "$INSTDIR' + $suffix + '"')
        $previousDirectory = $directory
    }
    $payloadLines.Add('File "' + (ConvertTo-NsisLiteral $file.FullName) + '"')
    $uninstallLines.Add('Delete "$INSTDIR\' + (ConvertTo-NsisLiteral $relative) + '"')
    $manifest.Add([pscustomobject]@{path=$relative.Replace('\','/');bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLower()})
}
foreach ($directory in Get-ChildItem -LiteralPath $BuildDirectory -Recurse -Directory | Sort-Object {$_.FullName.Length} -Descending) {
    $relative = $directory.FullName.Substring($BuildDirectory.Length + 1)
    $uninstallLines.Add('RMDir "$INSTDIR\' + (ConvertTo-NsisLiteral $relative) + '"')
}
$payloadInclude = Join-Path $workRoot 'payload.nsh'
$uninstallInclude = Join-Path $workRoot 'uninstall-files.nsh'
$manifestPath = Join-Path $workRoot 'files.json'
$payloadLines | Set-Content -LiteralPath $payloadInclude -Encoding utf8BOM
$uninstallLines | Set-Content -LiteralPath $uninstallInclude -Encoding utf8BOM
[pscustomobject]@{product='EZ Bench';version=$version;files=$manifest} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
$definitions = @('/V2',('/DPRODUCT_VERSION='+$version),('/DOUTPUT_FILE='+$OutputPath),('/DAPP_ICON='+(Join-Path $appRoot 'icon.ico')),('/DAPP_LICENSE='+(Join-Path $appRoot 'LICENSE')),('/DPAYLOAD_INCLUDE='+$payloadInclude),('/DUNINSTALL_INCLUDE='+$uninstallInclude),('/DFILES_MANIFEST='+$manifestPath))
& $CompilerPath @definitions (Join-Path $projectRoot 'installer\EZ-Bench.nsi')
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $OutputPath)) { throw 'Installer compilation failed.' }
$digest = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLower()
($digest + ' *' + [IO.Path]::GetFileName($OutputPath)) | Set-Content -LiteralPath ($OutputPath+'.sha256') -Encoding ascii
[pscustomobject]@{product='EZ Bench';version=$version;installer=[IO.Path]::GetFileName($OutputPath);sha256=$digest;bytes=(Get-Item -LiteralPath $OutputPath).Length;compiler=$compilerReported;compilerArchiveSha256=$compilerHash;compilerSource=$compilerUrl;clientFree=(!$AllowVendorTools);payloadFiles=$files.Count;signed=$false} | ConvertTo-Json | Set-Content -LiteralPath ($OutputPath+'.json') -Encoding utf8
Write-Output $OutputPath
