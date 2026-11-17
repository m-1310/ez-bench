param(
    [switch] $Apply,
    [string] $RootDirectory = (Split-Path -Parent $PSScriptRoot),
    [string] $ReportPath
)
$ErrorActionPreference = 'Stop'
$RootDirectory = [IO.Path]::GetFullPath($RootDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
$packagePath = Join-Path $RootDirectory 'app\package.json'
if (!(Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw 'Choose the EZ Bench project root.' }
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
if ($package.name -ne 'ez-bench' -or $package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid EZ Bench project identity.' }
$keepVersions = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
[void]$keepVersions.Add($package.version)
$currentDirectory = $null
$pointerPath = Join-Path $RootDirectory 'build\current.json'
if (Test-Path -LiteralPath $pointerPath) {
    $pointer = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
    if ($pointer.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid current release pointer; no cleanup performed.' }
    [void]$keepVersions.Add($pointer.version)
    $currentDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $pointer.executable))
    if (!(Test-Path -LiteralPath $pointer.executable -PathType Leaf)) { throw 'Current executable is missing; repair the pointer before cleanup.' }
}
$candidates = [Collections.Generic.List[object]]::new()
$preserved = [Collections.Generic.List[object]]::new()
$dependencyFixture = Join-Path $RootDirectory 'app\node_modules\ssh2\test\fixtures\id_rsa.ppk'
$dependencyFixtureHash = if (Test-Path -LiteralPath $dependencyFixture -PathType Leaf) { (Get-FileHash -LiteralPath $dependencyFixture -Algorithm SHA256).Hash } else { $null }
function Assert-Child([string] $Candidate, [string] $Parent) {
    $resolved = [IO.Path]::GetFullPath($Candidate)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (!$resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup path escaped its allowed directory.' }
    return $resolved
}
function Add-Candidate($Item, [string] $AllowedRoot) {
    $resolved = Assert-Child $Item.FullName $AllowedRoot
    if ($currentDirectory -and ($resolved.Equals($currentDirectory,[StringComparison]::OrdinalIgnoreCase) -or $currentDirectory.StartsWith($resolved+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase))) { throw 'Refusing to remove the current application directory.' }
    $entries = if ($Item.PSIsContainer) { @(Get-ChildItem -LiteralPath $resolved -Recurse -Force) } else { @($Item) }
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or @($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
        $preserved.Add([pscustomobject]@{path=$resolved;reason='Contains a junction or symbolic link; preserved.'}); return
    }
    $files = @($entries | Where-Object { !$_.PSIsContainer })
    $protected = @($files | Where-Object {
        $sensitiveName = $_.Name -in @('profiles.json','history.json','snippets.json') -or $_.Name -match '(?i)\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$|\.(?:bak|dump|key|ppk|pfx|p12)$'
        # ssh2 distributes this public test fixture inside node_modules. Exempt
        # only its exact dependency path and bytes, never arbitrary private keys.
        $knownFixture = $sensitiveName -and $dependencyFixtureHash -and $_.FullName -match '(?i)[\\/]node_modules[\\/]ssh2[\\/]test[\\/]fixtures[\\/]id_rsa\.ppk$' -and (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -eq $dependencyFixtureHash
        $sensitiveName -and !$knownFixture
    })
    if ($protected.Count) { $preserved.Add([pscustomobject]@{path=$resolved;reason='Contains possible user data or private keys; preserved.'}); return }
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    $candidates.Add([pscustomobject]@{path=$resolved;allowedRoot=[IO.Path]::GetFullPath($AllowedRoot);directory=[bool]$Item.PSIsContainer;files=$files.Count;bytes=[long]$bytes})
}
$buildRoot = Join-Path $RootDirectory 'build'
foreach ($item in Get-ChildItem -LiteralPath $buildRoot -Directory -ErrorAction SilentlyContinue) {
    if ($item.Name -match '^(?:EZ Bench|Work EZ Bench)(?: (?<version>\d+\.\d+\.\d+)(?:-(?:final|candidate))?)?$') {
        $version = if ($Matches.version) { $Matches.version } else { '0.1.0' }
        if (!$keepVersions.Contains($version)) { Add-Candidate $item $buildRoot }
    }
}
$releaseRoot = Join-Path $RootDirectory 'releases'
foreach ($item in Get-ChildItem -LiteralPath $releaseRoot -Force -ErrorAction SilentlyContinue) {
    $version = $null
    if ($item.Name -match '^(?<version>\d+\.\d+\.\d+)$') { $version = $Matches.version }
    elseif ($item.Name -match '^(?:EZ-Bench|Work-EZ-Bench)-(?:Source-|Setup-)?(?<version>\d+\.\d+\.\d+)(?:[-.].*)?$') { $version = $Matches.version }
    elseif (!$item.PSIsContainer -and $item.Name -match '^(?:release|validation|update)-(?<version>\d+\.\d+\.\d+)\..+$') { $version = $Matches.version }
    if ($version -and !$keepVersions.Contains($version)) { Add-Candidate $item $releaseRoot }
}
$targetRoot = Join-Path $RootDirectory 'target'
foreach ($item in Get-ChildItem -LiteralPath $targetRoot -Directory -ErrorAction SilentlyContinue) {
    if ($item.Name -match '^(?:clean-source-\d+\.\d+\.\d+-[a-f0-9]{32}|pre-(?:audit|private-tab-fix)-\d+\.\d+\.\d+|public-source-validation(?:-\d+\.\d+\.\d+|-final)?|source-smoke)$') { Add-Candidate $item $targetRoot }
    elseif ($item.Name -match '^installer-static-[a-f0-9]{32}$') { Add-Candidate $item $targetRoot }
}
foreach ($name in @('installer-build','release-candidates')) {
    $parent = Join-Path $targetRoot $name
    foreach ($item in Get-ChildItem -LiteralPath $parent -Directory -ErrorAction SilentlyContinue) {
        if ($item.Name -match '^(?<version>\d+\.\d+\.\d+)(?:[-.].*)?$' -and !$keepVersions.Contains($Matches.version)) { Add-Candidate $item $parent }
    }
}
$removed = [Collections.Generic.List[string]]::new()
if ($Apply) {
    # Inventory the complete plan before mutation, then revalidate each exact path.
    foreach ($candidate in $candidates) {
        $resolved = Assert-Child $candidate.path $candidate.allowedRoot
        if ($currentDirectory -and $resolved.Equals($currentDirectory,[StringComparison]::OrdinalIgnoreCase)) { throw 'Current application protection triggered.' }
        $item = Get-Item -LiteralPath $resolved -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Candidate changed into a reparse point; cleanup stopped.' }
        if ($candidate.directory) { Remove-Item -LiteralPath $resolved -Recurse -Force } else { Remove-Item -LiteralPath $resolved -Force }
        $removed.Add($resolved)
    }
}
$report = [ordered]@{mode=$(if($Apply){'applied'}else{'preview'});keepVersions=@($keepVersions);candidateCount=$candidates.Count;candidateBytes=[long](($candidates | Measure-Object -Property bytes -Sum).Sum);removedCount=$removed.Count;removed=@($removed);candidates=@($candidates);preserved=@($preserved);userDataTouched=$false}
if ($ReportPath) {
    $ReportPath = [IO.Path]::GetFullPath($ReportPath)
    New-Item -ItemType Directory -Path (Split-Path -Parent $ReportPath) -Force | Out-Null
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReportPath -Encoding utf8
}
[pscustomobject]@{mode=$report.mode;keepVersions=$report.keepVersions;candidateCount=$report.candidateCount;candidateBytes=$report.candidateBytes;removedCount=$report.removedCount;preserved=$report.preserved} | ConvertTo-Json -Depth 5
