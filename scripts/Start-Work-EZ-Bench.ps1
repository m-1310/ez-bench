param([string] $DataDirectory)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Start-EZ-Bench.ps1') -DataDirectory $DataDirectory
