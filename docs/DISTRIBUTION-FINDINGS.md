# Distribution & Signing Findings

Captured 2026-07-17 after a painful reinstall of the production app broke all
recording. Root cause was code-signing; everything else was a symptom. These
findings are the input for the GitHub DMG-release + auto-update spec.

## TL;DR — the one rule that matters

**Every build of the app must be signed with the SAME stable Apple signing
identity, with hardened runtime + the camera/mic entitlements.** If the signing
identity (its Designated Requirement) changes between builds, macOS silently
revokes the user's Screen Recording / Camera / Microphone grants and recording
fails with SCK error `-3801`. For an auto-updating app this is fatal: a mis-signed
update wipes permissions on every install. A Developer ID cert (paid Apple
Developer Program) is what makes this work for machines other than the developer's.

## What actually broke

1. `tauri build` produced a **broken ad-hoc signature**: `codesign --verify`
   failed with *"code has no resources but signature indicates they must be
   present"*, and the signing identifier was a random `zeigen-9d40b4c3...`
   instead of `com.zeigen.app`. macOS will not honor TCC grants for an app whose
   signature fails validation.
2. Because the signature was invalid/unstable, the previously-granted **Screen
   Recording** permission stopped applying → capture start failed with
   `SCStreamErrorDomain Code=-3801 "The user declined TCCs..."`.
3. Fixing the signature surfaced a second bug: re-signing with **hardened
   runtime** (`--options runtime`) but **no entitlements** blocked the webcam.
   The preview bubble uses `getUserMedia` in the WKWebView; under hardened
   runtime that needs `com.apple.security.device.camera` → without it,
   `NotAllowedError`.

## macOS TCC behavior we learned the hard way

- **Screen Recording records are path-based** (`client_type=1`), keyed on the
  binary path (`/Applications/Zeigen.app/Contents/MacOS/zeigen`) plus a stored
  **code-signature requirement (csreq)**. Camera/Mic records can be bundle-id or
  path based.
- **`tccutil reset <service> com.zeigen.app` does NOT clear a path-based Screen
  Recording record** — it only matches bundle-id entries. This wasted a lot of
  time: the reset reported success but touched nothing.
- When the binary's signature changes, the stored csreq no longer matches the
  binary on disk → the grant is **silently invalidated** while System Settings
  still shows the toggle ON (`auth_value=2`). Result: `-3801`, and toggling
  off/on only helps if the binary in place is the final, stably-signed one.
- Toggling the permission while signing was mid-flux **rewrote the record's
  csreq to an ad-hoc code-hash**, which then didn't match the cert-signed binary
  — so it stayed broken until the stale record was removed with the `−` button.
- Clearing a stale path-based Screen Recording record requires the **System
  Settings `−` button** (or installing a binary with a different signature to
  force a re-prompt). **SIP blocks editing `TCC.db` directly**, even for reads-OK
  Full Disk Access terminals.
- Two databases: **Screen Recording lives in the SYSTEM db**
  (`/Library/Application Support/com.apple.TCC/TCC.db`); **Camera/Mic live in the
  USER db** (`~/Library/Application Support/com.apple.TCC/TCC.db`).
- `auth_value`: 0=denied, 2=allowed. `auth_reason`: 4 = user-set (System
  Settings toggle), 2 = prompt. Useful for diagnosing from the DB (read-only).

## Signing / hardened runtime / entitlements

- The app bundle has **three Mach-O binaries** that all must be signed
  (inside-out): `zeigen` (main), `recording-engine`, `cicompositor` (declared via
  `bundle.externalBin`). The Designated Requirement to aim for:
  `identifier "com.zeigen.app" and certificate leaf = H"<cert hash>"` — stable
  across rebuilds because it's cert-based, not code-hash-based.
- **TCC attribution across the helper:** `recording-engine` (a child process that
  calls ScreenCaptureKit) is attributed to the **responsible process = the main
  app**, so granting "Zeigen" covers the helper. No separate grant needed.
- **Hardened runtime requires entitlements** for device access. We added
  `src-tauri/entitlements.plist` with:
  - `com.apple.security.device.camera`
  - `com.apple.security.device.audio-input`
- **Screen Recording is NOT gated by hardened-runtime entitlements** (pure TCC),
  which is why screen capture worked while the webcam didn't — a useful
  diagnostic signal.
- **Notarization requires hardened runtime + entitlements**, so keeping hardened
  runtime on (with the entitlements) is the right call for public distribution.

## Current repo state (already changed this session)

- `src-tauri/tauri.conf.json` now sets:
  ```json
  "macOS": { "signingIdentity": "Zeigen Dev Signing", "entitlements": "entitlements.plist" }
  ```
- `src-tauri/entitlements.plist` added (camera + audio-input).
- The **installed** `/Applications/Zeigen.app` was manually re-signed with the
  stable self-signed cert `Zeigen Dev Signing` (in the login keychain, valid to
  2036) + hardened runtime + entitlements. Verified: `codesign --verify` passes.
- **NOT yet verified:** that a fresh `tauri build` (with the new config) produces
  a valid signature. The broken-seal bug appeared in the build output, not just
  the install copy — confirm `codesign --verify --deep --strict` on a freshly
  built bundle before trusting it.

## Implications for the DMG release + auto-update spec

### Signing identity — the pivotal decision
- **Self-signed (`Zeigen Dev Signing`)** works only on machines whose keychain
  trusts that cert (i.e. the developer's own Mac). For anyone else, Gatekeeper
  blocks it and TCC grants can't be established cleanly. Not viable for a public
  GitHub release.
- **Developer ID Application cert (paid Apple Developer Program, ~$99/yr) +
  notarization + stapling** solves three problems at once: Gatekeeper trust,
  clean install on any Mac, AND a stable Designated Requirement so **TCC grants
  survive every auto-update**. This is the recommended path if the audience is
  anyone but the developer.
- Downloads from GitHub carry the `com.apple.quarantine` xattr → Gatekeeper
  enforcement. Notarization is what makes the first launch smooth (no
  right-click-open, no "app is damaged").

### DMG release via GitHub
- `tauri build` already emits a `.dmg` (`bundle.targets: "all"`). For a release,
  build in **GitHub Actions with `tauri-action`**, which builds, signs, notarizes
  (when Apple secrets are present), and publishes the DMG to a GitHub Release.
- Secrets CI needs for signing+notarization: `APPLE_CERTIFICATE` (base64 p12),
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`.

### Auto-update (Tauri v2 updater)
- Uses `tauri-plugin-updater` (Rust) + `@tauri-apps/plugin-updater` (JS). App
  checks an update manifest (`latest.json`) hosted on GitHub Releases, downloads
  the new bundle, verifies it, installs, relaunches.
- **Update signing is a SEPARATE key from Apple codesign** — Tauri uses its own
  **minisign** keypair (`tauri signer generate`). Public key goes in
  `tauri.conf.json` (`plugins.updater.pubkey`); private key + password are build
  env vars (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
  You need **both** signatures: Apple codesign (so macOS runs it / TCC persists)
  and Tauri minisign (so the updater trusts the download).
- macOS update artifact is a **`.app.tar.gz` + `.sig`** (separate from the DMG),
  plus `latest.json`. `tauri-action` can generate and attach all of these
  (`includeUpdaterJson: true`).
- **The critical carry-over from this session:** every published update MUST be
  signed with the **same Apple Developer ID cert**. If an update ships with a
  different or ad-hoc identity, users hit exactly the `-3801` /
  camera-`NotAllowedError` breakage we just spent hours on — but silently, on
  their machines, on an auto-update they didn't ask for.

## Open decisions the spec must resolve

1. **Audience:** developer's machines only, or public distribution? Determines
   self-signed (cheap, dev-only) vs Developer ID + notarization (required for
   anyone else).
2. **Apple Developer Program:** will you enroll ($99/yr)? Needed for
   notarization, smooth installs, and durable TCC across updates for other users.
3. **Update hosting/cadence:** GitHub Releases `latest.json` endpoint; how the
   updater endpoint URL is templated (`{{target}}`/`{{arch}}`/`{{current_version}}`).
4. **Versioning/tagging:** git tag → CI release flow, and where the version of
   record lives (`tauri.conf.json` `version` / `Cargo.toml`).
