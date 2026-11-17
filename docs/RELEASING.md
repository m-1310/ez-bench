# Build EZ Bench on Windows

Use Windows x64, PowerShell 7, Node.js 24 LTS, and 7-Zip. Follow the [setup steps](../README.md#run-from-a-fresh-clone) before building. Run these commands from the repository root:

```powershell
./scripts/Build-App.ps1 -ClientFree
./scripts/Package-App.ps1
./scripts/Build-Installer.ps1
```

The portable app is built in `build/EZ Bench <version>/`. The scripts write the ZIP, setup, and checksums to `releases/<version>/`. Setup uses NSIS 3.13 or later. The installer script can download the pinned compiler and verify its SHA-256, or you can pass `-CompilerPath` for an existing installation. For a portable build, extract the entire ZIP before running `EZ Bench.exe`.

## Verify the release

```powershell
$version = (Get-Content app/package.json -Raw | ConvertFrom-Json).version
$setup = "./releases/$version/EZ-Bench-Setup-$version.exe"
./installer/Verify-Installer.ps1 -InstallerPath $setup -BuildDirectory "./build/EZ Bench $version"
./installer/Test-Installer.ps1 -InstallerPath $setup
```

The first script compares file hashes without launching setup. The second runs install, reinstall, and uninstall in a project test directory with Desktop, Start menu, and registry changes suppressed. Run the second on a computer that permits execution of the build. Windows Smart App Control can block unsigned setup and unsigned application executables. See the [0.9.8 test results](VERIFICATION-0.9.8.md).

`./scripts/Build-Release.ps1` runs dependency setup, tests, packaging, and static verification in sequence. It requires a host that can launch the packaged app. GitHub Actions runs Windows tests on pull requests. A manual workflow run can also upload downloadable build artifacts for review.

## Runtime dependencies and updates

The standard packages include Electron and the SQL drivers. Install matching vendor tools separately for native MySQL, MariaDB, or PostgreSQL backup and restore. See the [database tool notes](THIRD-PARTY-DATABASE-TOOLS.md).

Update feeds require explicit [HTTPS feed and Ed25519 configuration](UPDATES.md). Keep the signing private key outside the repository. For Windows distribution, Authenticode signing is a separate release step covering the app, uninstaller, and setup.
