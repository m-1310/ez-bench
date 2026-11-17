# Windows releases and in-app updates

For a Git installation, follow the [Git update instructions](../README.md#update-a-git-installation).

EZ Bench has a manual update flow under **Help > Check for updates** and **Settings > Check for updates**. It performs no startup check, background polling, automatic download, scheduled task or update service. The UI polls progress only while an update operation is active. Checks send an ordinary HTTPS request to the configured feed, not database details, SQL, profiles or credentials.

## Packaged app workflow

1. Open Updates and choose **Check now**.
2. If a newer stable Windows x64 release exists, choose **Download update**.
3. EZ Bench verifies the feed's Ed25519 signature and the installer's signed size and SHA-256. HTTPS and a build-time host allowlist apply to every redirect. An invalid signature, changed download, wrong platform, downgrade, unsupported Windows build or failed request does not enable installation.
4. Save SQL files, finish transactions, apply or discard table edits, and disconnect from the database.
5. Choose **Close and install**, then confirm the native dialog. The installer waits up to two minutes for the exact requesting process to exit. It never kills EZ Bench or bypasses a canceled close. Normal interactive setup then updates the registered per-user installation. A portable copy installs separately into the per-user location; it does not overwrite the portable folder.

**Show installer** reveals the verified setup for manual use. Closing the app without installing removes this session's completed download. A canceled/failed download removes its partial file. Interrupted processes can leave temporary files for normal Windows temporary-file cleanup. Launching setup retains its downloaded file so Windows can execute it.

Profiles, ordinary query history and editor recovery remain in `%APPDATA%\Work EZ Bench`. Database files and backups are separate. Private SQL buffers are deliberately not recovered; save necessary SQL explicitly before closing. Setup does not restart the application automatically.

Windows application policy can block an unsigned setup. A signed update manifest authenticates the release to EZ Bench; it is **not** an Authenticode signature and does not grant Windows publisher trust. Use an approved Windows code-signing process before publishing if required. Never bypass Windows security policy.

## Enable a feed for a build

This local build has updates **disabled** until the release owner supplies a real HTTPS feed and Ed25519 public key. No placeholder GitHub account, private key or public server was created. Version 0.5.0 has no updater; users must install/extract an update-capable release once before future in-app updates are possible.

Use a stable HTTPS address. For a public GitHub repository, a suitable feed is:

```text
https://github.com/OWNER/REPOSITORY/releases/latest/download/update.json
```

Publish the signed manifest as `update.json` in each stable release. Its installer URL must identify the exact version, for example:

```text
https://github.com/OWNER/REPOSITORY/releases/download/v0.7.0/EZ-Bench-Setup-0.7.0.exe
```

For other HTTPS hosting, put the feed and installer on the same hostname. Additional download hosts can be supplied in the source configuration for a deliberately customized distribution; the default build command permits only the feed host, plus GitHub's documented asset hosts when the feed is on github.com. Private GitHub repositories requiring authentication are not supported. Tokens are never embedded in update URLs.

Generate a release signing key **once**, outside the project and release folders:

```powershell
node ./scripts/update-release.cjs keygen 'E:/ReleaseKeys/ez-bench.key' 'E:/ReleaseKeys/ez-bench.pub'
```

These example paths must be replaced with an existing private storage directory. Restrict the private file's Windows ACL, back it up securely, and keep it out of Git, artifacts, cloud uploads and public documentation. The script refuses existing key paths. It does not set Windows ACLs. Only the `.pub` file belongs in a configured build. Keep the same public key across updates; key rotation needs a deliberately shipped transition release. Losing the private key prevents producing updates trusted by existing builds.

Build with the stable feed and public key:

```powershell
./scripts/Build-App.ps1 -ClientFree `
  -UpdateFeedUrl 'https://github.com/OWNER/REPOSITORY/releases/latest/download/update.json' `
  -UpdatePublicKeyPath 'E:/ReleaseKeys/ez-bench.pub'
```

The source `app/update-config.json` remains disabled. Build-App writes the reviewed public configuration only into the new packaged app. The public source preparation script includes the disabled source config and never copies a release private key.

GitHub Actions accepts repository variables `EZ_BENCH_UPDATE_FEED_URL` and `EZ_BENCH_UPDATE_PUBLIC_KEY` for the same public build configuration. Set both or neither. CI still uploads build artifacts only; it does not publish releases or receive a signing private key. Generate the signed manifest locally against the exact reviewed installer, then upload it manually with that installer. Pull-request builds should use only trusted repository variables and remain subject to review.

## Prepare the next release

Set a new stable `major.minor.patch` version in `app/package.json` and `app/package-lock.json`, and update visible version strings and current documentation. Windows version components must be at most 65535. Retain prior tested outputs.

For a release without a live update feed:

```powershell
./scripts/Build-Release.ps1
```

For an update-enabled release, supply all four options:

```powershell
./scripts/Build-Release.ps1 `
  -UpdateFeedUrl 'https://github.com/OWNER/REPOSITORY/releases/latest/download/update.json' `
  -UpdatePublicKeyPath 'E:/ReleaseKeys/ez-bench.pub' `
  -InstallerUrl 'https://github.com/OWNER/REPOSITORY/releases/download/v0.7.0/EZ-Bench-Setup-0.7.0.exe' `
  -UpdatePrivateKeyPath 'E:/ReleaseKeys/ez-bench.key'
```

The command checks key matching, runs backend and desktop tests, audits production dependencies, builds the app, tests the packaged desktop, creates the portable ZIP and setup, statically verifies the embedded payload, and prepares the public source snapshot. It creates `update-VERSION.json` and its hash sidecar when configured. It refuses existing release outputs and performs no publication or user-database access. It does not execute setup; install/update/uninstall and Windows 10 compatibility must be tested on permitted test machines.

If an Authenticode signing step changes the installer, run it **before** generating update metadata. Then regenerate the installer hash sidecar and metadata, and sign the final installer bytes:

```powershell
node ./scripts/update-release.cjs manifest `
  './releases/EZ-Bench-Setup-0.7.0.exe' `
  'https://github.com/OWNER/REPOSITORY/releases/download/v0.7.0/EZ-Bench-Setup-0.7.0.exe' `
  'E:/ReleaseKeys/ez-bench.key' '0.7.0' './releases/update-0.7.0.json'
```

The signer refuses existing manifest paths. Preserve the previous manifest and choose a new output path when re-signing. It supports stable Windows x64 setup downloads up to 512 MiB. Prerelease channels, delta updates, automatic restart, authenticated feeds, managed enterprise deployment and ARM64-native packages are outside this release.

Review prepared source and artifacts. Manually upload the versioned installer and the signed manifest renamed to `update.json` to the intended stable release only after authorization. Keep the private key off GitHub. Publishing and repository pushes are not performed by the application or build scripts.

## Windows compatibility boundary

The package targets Windows 10 and Windows 11, x64. Setup rejects older Windows and systems without x64 execution support. It uses current-user installation and needs no administrator rights, Node.js installation, service or startup task. This follows [Electron's Windows 10+ support](https://github.com/electron/electron#platform-support); this build does not promise every future Windows version.

Development and packaged desktop checks ran on the development computer. A Windows 10 VM/hardware run and real installer upgrade/uninstall remain separate validation requirements. Static compiler/payload verification does not establish those runtime results.
