# Dev machine setup

What a fresh machine needs beyond `git clone`. Written 2026-07-13 during a machine transfer; versions are what the project was last built with, not hard minimums.

## Toolchain

- Node 22.x (v22.20.0) + npm, then `npm install`
- Rust stable (1.94.1) via rustup
- Xcode 26.x with command line tools (Swift 6.2+ builds `src-tauri/recording-engine/`)
- ffmpeg + ffprobe via Homebrew at `/opt/homebrew/bin/` — the paths are hardcoded (`composite.rs::FFMPEG_PATH`); ffmpeg 8.x
- Run: `npm run tauri dev`. Install to /Applications: `scripts/install-app.sh` (requires the signing cert below).

## Code signing cert — required before first install-app.sh run

The install script signs the installed app with a self-signed login-keychain certificate named **"Zeigen Dev Signing"** so every build keeps the same code-signing identity and macOS TCC grants (Screen Recording / Camera / Mic) survive rebuilds. Without it, each rebuild is a new identity: TCC shows "allowed" but SCK fails with `-3801 "user declined"` and never re-prompts. The script fails fast if the cert is missing.

On a new machine, recreate it:

1. `openssl req -x509` with CN = `Zeigen Dev Signing`, ~3650 days, extensions: `basicConstraints=critical,CA:false`, `keyUsage=critical,digitalSignature`, `extendedKeyUsage=critical,codeSigning`
2. Export to p12, then `security import <p12> -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign`
3. `security add-trusted-cert -p codeSign -r trustRoot -k ~/Library/Keychains/login.keychain-db <cert.pem>` (GUI password prompt)

A new cert is a new identity — grant permissions once after the first signed install.

**Do not set `signingIdentity` in tauri.conf.json.** The project lives in iCloud-synced Documents; build outputs carry file-provider xattrs (`com.apple.provenance`, `com.apple.macl`) that codesign rejects as detritus, and `com.apple.macl` cannot be stripped in place. The script instead copies the bundle clean into /Applications with `ditto --norsrc --noextattr --noacl` and signs there.

## macOS permissions

Grant to the installed Zeigen.app (and separately to the terminal/IDE running `tauri dev` — dev builds are their own TCC identity):

- Screen Recording (SCK capture)
- Camera, Microphone
- Nothing else — cursor telemetry deliberately avoids Input Monitoring and Accessibility (`CursorTracker.swift` uses permission-free counter polling).

## Dev gotchas (machine-adjacent)

- **`tauri dev` exits 0 silently if the installed Zeigen.app is running** — single-instance plugin. Quit the prod app first.
- **macOS Voice Isolation mic mode** zeroes Zeigen's audio between speech and eats transients. Before debugging "desync" or "dead air": Control Center → Zeigen camera panel → Mic Mode = Standard.
- Port 1420 must be free (vite dev server).

## Test data that lives outside the repo

Committed fixtures cover the zoom detector and mask/shadow tests. Two test groups read `~/Movies/Zeigen/` directly and are `#[ignore]`d/fail-fast without it:

- `~/Movies/Zeigen/.phase15-baseline/` (~153 MB, three recordings) — phase-15 baseline comparisons.
- `~/Movies/Zeigen/.scratch-baseline-c1/recording-2026-05-19-114549/` — already missing since May; the five stream-md5 guards that read it are a known gap (DECISIONS.md 2026-07-13) to be restored before zoom step 4.

Copy `.phase15-baseline/` to the new machine (or regenerate baselines) to keep those tests meaningful.
