# Watermark in the review window — Context

**Gathered:** 2026-05-28
**Status:** Ready for planning
**Branch:** `capture-engine-v2` (daily-driver line)
**Source of truth for scope:** this doc + `CLAUDE.md` §"Coding standards"

A new feature, not a tweak: let the user pick a transparent logo PNG and a corner in the review window, see it overlaid live in the review preview, and have it baked into the output of every export path (Save MP4, Copy to Clipboard, LinkedIn, GIF). The logo + corner are remembered across recordings and app launches.

## Forward-merge (pre-feature)

No-op, verified 2026-05-28. Local `main` (`2484bb9`) == the `capture-engine-v2` merge-base; `git log --oneline main --not capture-engine-v2` is empty. Nothing to merge in. (Same state as the V2.3 phase start; the daily driver is still the `v1.0` tag.)

## Feature boundary

In scope:
- A "Watermark" section in the review window: file picker (transparent PNG), corner selector (TL/TR/BL/BR, default TR), per-recording "Apply watermark" toggle, and global Change/Remove of the saved logo (D-05).
- Live watermark in the review preview via a CSS overlay on the `<video>` (D-04).
- Watermark baked into all four export outputs: Save MP4, GIF, Copy to Clipboard, LinkedIn (D-01, D-02).
- Persistence of `{ logo_path, corner }` across recordings and launches via a hand-rolled `settings.json` — the app's first persisted-prefs mechanism (D-03).
- Logo copied into app storage on pick so preview + ffmpeg + persistence read one stable file (D-04).
- Capability + asset-scope changes to enable the file picker and the preview (D-06).

Out of scope:
- Watermark text/positioning beyond the four corners (no free-drag, no opacity slider, no multiple logos) — corners only, full PNG alpha.
- Animated / per-time-range watermark (it spans the whole clip).
- Editing the saved-logo *bytes* (crop/resize) inside Zeigen — the user supplies a finished PNG.
- A general settings/preferences window — `settings.json` holds only the watermark keys for now; other prefs (hotkey, device, webcam size) remain unpersisted as today.
- Engine / capture changes — this is entirely review-window + export-pipeline + a new settings module.

## Carried-forward decisions

- **Coding standards** (CLAUDE.md): simplicity, no over-engineering, no defensive programming, no emojis, identify root cause before fixing. Directly shapes D-02 (reuse the existing overlay machinery, one shared helper) and D-03 (hand-rolled JSON, no new plugin).
- **Bundle id `com.zeigen.app`** (tauri.conf.json:5; exports.rs hardcodes `~/Library/Caches/com.zeigen.app`). Settings + the logo copy live under the matching `~/Library/Application Support/com.zeigen.app/`.
- **Asset-protocol scope is explicit** (tauri.conf.json:29 — `~/Movies/Zeigen/**` + the thumbs cache). Anything the webview loads via `convertFileSrc` must be inside the scope; an arbitrary `~/Downloads` path is not (drives D-04).
- **Export-pipeline shape** (edit.rs): Save MP4 / GIF / Copy-to-Clipboard all run through `run_edit_pipeline` (`edit.rs:575`); LinkedIn runs its own ffmpeg (`linkedin.rs:62`). `resolution`/`fps` are passed to export commands as args, not stored in the sidecar (shapes D-01).
- **Sidecar = content edits only** (edit.rs `SidecarState`: trim, annotations, bubble log). The watermark is an export-time option, not a content edit — it does not go in the sidecar (D-01).

## Implementation decisions

### D-01: Watermark plumbed as explicit export-command args, not the sidecar

The watermark is an export-time choice, exactly like `resolution`/`fps` — which are already command args, not sidecar fields. So thread an optional watermark `(logo_path, corner)` through the four export commands (`save_recording`, `clipboard_copy_recording`, `linkedin_export`; `save_recording` covers both MP4 and GIF). The review UI sources the values from `settings.json` + the per-recording "Apply" toggle and passes them on export. "Disabled for this recording" = the UI passes `None`. No sidecar schema change; consistent with the existing resolution/fps model.

### D-02: One shared overlay helper, reused by both export routes

A small helper takes `(logo_path, corner, source_w, source_h)` and returns the extra ffmpeg `-i` input plus an overlay-fragment builder. Two consumers:
- `run_edit_pipeline` (`edit.rs:575`) — append the watermark overlay to the existing filter graph, *after* the text/arrow overlays (so the logo sits on top) and *before* the resolution/GIF scale tail (so it scales proportionally with the frame). Presence of a watermark forces `needs_filter = true` (so a watermarked MP4-Source no longer hits the `-c:v copy` noop path — expected, a watermark requires a re-encode).
- `linkedin_export` (`linkedin.rs:62`) — convert its `-vf "scale=...,format=yuv420p"` to a `-filter_complex` that overlays the watermark first, then scales + formats, mapping `[outv]` + `0:a`.

Reuse the existing `Corner` enum (`composite.rs:139`) and its `overlay_xy(padding)` method (`composite.rs:147`) — it already emits the `main_w-overlay_w-{pad}:{pad}` expressions for all four corners; expose it `pub(crate)`. Sizing: scale the logo to **10% of the shorter source dimension** as its height (preserve aspect via `scale=-2:H`), padding **2% of the shorter source dimension** (computed in px from `probe_dimensions`, then passed to `overlay_xy`). Respect the PNG's own alpha — no extra dimming.

### D-03: First persisted-prefs mechanism — hand-rolled settings.json

No settings/prefs persistence exists today (no `localStorage`, no settings file, hotkey not even persisted). Add a small `settings` module (Rust) that reads/writes `~/Library/Application Support/com.zeigen.app/settings.json` — resolved via `AppHandle::path().app_config_dir()` (mirrors the resource-dir pattern at `lib.rs:551`). One serde struct, `{ watermark: { logo_path: Option<String>, corner: String } }`. Two commands: `get_settings`, `set_watermark_settings`. Hand-rolled JSON, no `tauri-plugin-store` — matches the hand-rolled sidecar and the simplicity standard.

### D-04: Copy the picked logo into app storage; preview via the stable copy

On pick, copy the chosen PNG to `~/Library/Application Support/com.zeigen.app/watermark.png` and remember **that copy's** path in `settings.json`. This single stable file is read by: the CSS preview (`convertFileSrc`, now in-scope), the ffmpeg export overlay, and the next-launch default. Deleting/moving the original is harmless. The CSS preview is an absolutely-positioned `<img>` over the `<video>` (`Review.tsx:1173`), positioned against the video's *rendered content box* (account for object-fit letterboxing when panel aspect ≠ video aspect) using the same 10%-height / 2%-padding math as the ffmpeg side, so it is WYSIWYG. No real-time re-compositing.

### D-05: Review "Watermark" section UI

A new section near the export controls:
- File row: current logo filename once chosen, with **Change…** (re-pick, updates the global saved logo) and **Remove** (forget the saved logo entirely — clears `settings.json`).
- **Apply watermark** checkbox — per-recording skip. On by default once a logo is saved; unchecking exports this clip with no watermark but keeps the remembered logo for the next recording.
- Corner selector: TL / TR / BL / BR radio, default **TR** when nothing has been picked yet. Changing the corner updates the global saved corner.

File picker via `@tauri-apps/plugin-dialog` `open({ filters: [{ name: "PNG", extensions: ["png"] }] })`.

### D-06: Capability + asset-scope changes

- `capabilities/default.json`: add `dialog:allow-open` (only `dialog:allow-ask` is present today).
- `tauri.conf.json` asset scope: add `$APPCONFIG/**` (or the explicit `$HOME/Library/Application Support/com.zeigen.app/**`) so the copied `watermark.png` loads via `convertFileSrc`.

## Known caveats (accepted, documented)

- **GIF palette:** overlaying a multi-color logo before palette quantization can slightly posterize it in the 256-color GIF. Accepted — the user wants the watermark on every path.
- **Webcam-bubble overlap:** the scratch is already composited with the webcam bubble, so picking the same corner as the bubble overlaps it. Default TR is usually clear of a bottom-corner bubble; user can pick another corner.
- **Re-encode on watermark:** a watermarked Source-resolution MP4 can no longer `-c:v copy`; it re-encodes via `h264_videotoolbox`. Expected.

## Claude's Discretion

- Exact UI placement of the Watermark section within the review layout, and styling (match existing controls).
- Whether the shared overlay helper lives in `composite.rs` (alongside `Corner`) or a tiny new `watermark.rs` module. Lean `composite.rs` to keep `Corner` + overlay logic together; promote to its own module only if it grows.
- Exact filename for the copied logo (`watermark.png` vs preserving the original stem). Lean a fixed `watermark.png` (single stable slot, overwritten on Change).
- Whether `get_settings` returns the whole settings struct or a watermark-specific shape. Lean whole struct (extensible).
- `scale=-2:H` vs computing an explicit even width. Lean `-2` for guaranteed-even width.

## Code context

### Files edited
- `src/Review.tsx` (2880 lines) — new Watermark section (D-05); CSS preview overlay over the `<video>` (`:1173`); pass watermark args into the four export invokes (`save_recording` `:424`, `clipboard_copy_recording` `:2412`, `linkedin_export` `:2456`). Reads settings on open, writes on Change/Remove/corner-change.
- `src-tauri/src/edit.rs` — `run_edit_pipeline` (`:575`) gains an optional watermark overlay; `save_recording` (`:887`) + threads the arg; `needs_filter`/noop logic accounts for the watermark.
- `src-tauri/src/clipboard.rs` — `clipboard_copy_recording` (`:107`) threads the watermark arg into `run_edit_pipeline`.
- `src-tauri/src/linkedin.rs` — `linkedin_export` (`:62`) converts `-vf` to `-filter_complex` with the watermark overlay.
- `src-tauri/src/composite.rs` — expose `Corner::overlay_xy` as `pub(crate)` (`:147`); home for the shared overlay helper (Discretion).
- `src-tauri/src/lib.rs` — register the new `settings` module + its commands in `invoke_handler` (`:606`); resolve the app-config dir at setup if needed (`:541`).
- `src-tauri/tauri.conf.json` — asset scope adds the app-config dir (D-06).
- `src-tauri/capabilities/default.json` — add `dialog:allow-open` (D-06).

### Files created
- `src-tauri/src/settings.rs` — `settings.json` read/write + the copy-logo-on-pick command (D-03, D-04).

### Reusable references (read-only)
- `src-tauri/src/composite.rs` `Corner` (`:139`) + `overlay_xy` (`:147`) — the corner-positioning expressions to reuse; `PADDING_PX` (`:157`) is the webcam composite's fixed 24px (watermark computes padding dynamically instead).
- `src-tauri/src/edit.rs` `run_edit_pipeline` filter-graph construction (`:684`–`:783`) — the overlay-chain pattern the watermark slots into; `probe_dimensions` (`:162`) for source dims.
- `src-tauri/src/exports.rs` `recording_exports_dir` (`:27`) — the `~/Library/Caches/com.zeigen.app/` convention the App Support path mirrors.

## Deferred ideas

- Watermark opacity slider, free-drag positioning, multiple saved logos — out of scope; corners + full alpha only.
- A general preferences window once a second persisted setting appears (`settings.json` is structured to extend).
- Persisting other prefs (hotkey, last device, webcam size) now that a settings file exists — separate follow-up.

## Decomposition (preview — locked in PLAN)

Three atomic commits, build order **c1 → c2 → c3** (c3 UI depends on c1 settings + c2 export args):
- **c1 — settings + logo storage foundation.** New `settings.rs` (`get_settings`, `set_watermark_settings`, copy-logo-on-pick), `settings.json` at App Support, capability `dialog:allow-open`, asset-scope entry. Done-when: pick a PNG → it lands at `watermark.png`, persists across relaunch, and is loadable via `convertFileSrc`.
- **c2 — watermark baking in all export paths.** Shared overlay helper; `run_edit_pipeline` + `linkedin_export` overlay; thread the arg through `save_recording`/`clipboard_copy_recording`/`linkedin_export`. Done-when: a watermark arg produces the logo in the output of all four paths at the correct corner/size/padding; `None` leaves output byte-unchanged vs today (noop still `-c:v copy`).
- **c3 — review UI + live preview.** Watermark section (picker, corner, Apply toggle, Change/Remove), CSS preview overlay, wiring settings ↔ UI ↔ export args. Done-when: the preview overlay matches the exported placement (WYSIWYG), Apply-off skips the watermark for that clip while keeping the saved logo, Remove forgets it.

---

*Feature: watermark-review-window*
*Context gathered: 2026-05-28*
