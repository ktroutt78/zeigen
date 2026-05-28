# Watermark in the review window — Plan

**Drafted:** 2026-05-28
**Status:** Ready to execute
**Source of truth for decisions:** `docs/WATERMARK-CONTEXT.md`
**Verification logo:** `/Users/keithtroutt/Downloads/Archetype_Logo_Icon_Color.png` (transparent PNG, 4491×2903, ~1.55:1)

Three atomic commits, build order **c1 → c2 → c3**. c1 (settings) and c2 (export baking) are independent and could parallelize; c3 (UI) depends on both. No engine/capture changes — entirely review-window + export-pipeline + a new settings module.

---

## c1 — settings + logo-storage foundation

### Files touched
- **CREATE** `src-tauri/src/settings.rs` — settings struct + read/write + the four commands.
- `src-tauri/src/lib.rs` — `mod settings;`, register commands in `invoke_handler` (`:606`).
- `src-tauri/capabilities/default.json` — add `dialog:allow-open`.
- `src-tauri/tauri.conf.json` — asset scope adds `$APPCONFIG/**` (resolves to `~/Library/Application Support/com.zeigen.app/`).

### Shape
```rust
struct Settings { watermark: WatermarkSettings }                        // serde, Default
struct WatermarkSettings { logo_path: Option<String>, corner: String }  // default corner "tr"
```
Paths via `AppHandle::path().app_config_dir()`: `settings.json` + `watermark.png` live there.

Commands:
- `get_settings(app) -> Settings`
- `set_watermark_logo(app, source_path) -> Settings` — validate `.png`, copy to `watermark.png`, set `logo_path`, persist, return updated Settings (UI converts the path for preview)
- `set_watermark_corner(app, corner)` — validate ∈ {tl,tr,bl,br}, persist
- `clear_watermark_logo(app)` — remove `watermark.png` (best-effort), null `logo_path`, persist

### Key behaviors
- **First-run (no settings.json):** `get_settings` returns `Default` (`logo_path: None`, `corner: "tr"`). No file written until a `set_*`.
- **Corrupt/malformed settings.json:** parse error → log `[settings] malformed, using defaults: {e}` and return `Default`. Never crash, never delete. The next `set_*` overwrites with valid JSON. (I/O read error → same fallback.)
- **"Is there a logo set?"** = `logo_path.is_some()` **and** the file exists on disk. A dangling `logo_path` (file manually deleted) is treated as no-logo by consumers (UI + export); `get_settings` stays a pure read (no auto-clear side effect).
- **Apply toggle is NOT here** — it is per-recording UI state (c3), never persisted.

### Done-when
- Fresh machine: `get_settings` returns defaults, no error, no file created.
- `set_watermark_logo(<verification logo>)` → `~/Library/Application Support/com.zeigen.app/watermark.png` exists; `settings.json` `logo_path` points to it; relaunch → `get_settings` returns it; the copy loads via `convertFileSrc` (asset scope works).
- Hand-written garbage in settings.json → defaults + log, no crash; next `set_*` rewrites valid JSON.
- `clear_watermark_logo` removes the png + nulls `logo_path`.
- Verified via a `cargo test` round-trip (write→read, corrupt→default) plus a manual `set_watermark_logo` smoke against the verification logo. (Picker UI is c3.)

### Commit
`feat(watermark c1): settings.json + logo storage foundation`

---

## c2 — watermark baking across all four export paths

### Files touched
- `src-tauri/src/composite.rs` — expose `Corner::overlay_xy` as `pub(crate)` (`:147`); add the shared `Watermark` helper.
- `src-tauri/src/edit.rs` — `run_edit_pipeline` (`:575`) gains `watermark: Option<Watermark>`; watermark overlay section + `needs_filter`/noop logic; `save_recording` (`:887`) threads args.
- `src-tauri/src/clipboard.rs` — `clipboard_copy_recording` (`:107`) threads args.
- `src-tauri/src/linkedin.rs` — `linkedin_export` (`:62`) `-vf` → `-filter_complex` with the overlay.

### Shared helper — identical across all four paths
```rust
pub(crate) struct Watermark { logo_path: PathBuf, corner: Corner }

impl Watermark {
    // Caller pushes `-i logo_path` first, then calls this with the resulting
    // input index + the prev/next graph labels + source dims.
    // Returns: "[{idx}:v]scale=-2:{h}[wm];[{prev}][wm]overlay={xy}[{next}]"
    //   h   = round(min(sw,sh) * 0.10)   (logo height; -2 = even auto width)
    //   pad = round(min(sw,sh) * 0.02)   (fed to Corner::overlay_xy)
    fn filter_fragment(&self, logo_idx, prev_label, next_label, sw, sh) -> String
}
```
**Why it is path-agnostic:** every consumer does the same three steps — (a) add `-i logo_path`, (b) get the fragment, (c) wire `next_label` into its own tail. Placement and tail differ; the fragment does not.
- **Save MP4 / GIF / Copy** = `run_edit_pipeline`: append after text/arrow overlays, before the scale/GIF tail (logo on top, scales with frame). Copy is the same path (Mp4/Source) — no separate work.
- **LinkedIn**: logo is input 1; fragment yields `[next]`, then linkedin appends `;[next]scale='min(1920,iw)':-2,format=yuv420p[outv]`, `-map [outv] -map 0:a?`.

### Args contract (what c3 sends)
- `watermark_logo: Option<String>` — absolute path to the copied `watermark.png`; `None`/absent when Apply is off or no logo.
- `watermark_corner: Option<String>` — `"tl"|"tr"|"bl"|"br"`; defaults `"tr"` if logo present, corner absent.
- Both reach `run_edit_pipeline` as `Option<Watermark>` (logo `None` → `None`).

### Key behaviors
- Watermark present forces `needs_filter = true` (a Source MP4 with watermark re-encodes via `h264_videotoolbox` — no `-c:v copy`).
- **Missing logo file** (path set but file gone): skip the watermark + log, export still succeeds — never lose the recording over a missing logo.

### Done-when
- Using the verification logo `/Users/keithtroutt/Downloads/Archetype_Logo_Icon_Color.png`, the logo appears in the output of all four paths — correct corner, ~10% height, ~2% padding — verified concretely on: MP4-Source, MP4-720p, GIF, the Copy-to-Clipboard temp file, and the LinkedIn mp4.
- **No-watermark regression check — RUN, do not assume.** After c2 lands, with no watermark, run `cargo test --lib save_recording_baseline -- --ignored --nocapture` and report the result in the commit body. This exercises the noop MP4-Source `-c:v copy` path (video stream md5 must equal source, audio md5 must differ from arnndn) plus the per-format collision and GIF paths. A silent regression in the noop-copy path would otherwise surface weeks later. (Prereq: the `~/Movies/Zeigen/.scratch-baseline-c1/` fixture must exist; if absent, note it and run an equivalent ad-hoc noop-save md5 check instead.)
- One helper, no duplicated overlay-string logic between `edit.rs` and `linkedin.rs`.

### Commit
`feat(watermark c2): bake watermark into all four export paths via shared overlay helper`

---

## c3 — review UI + live preview

### Files touched
- `src/Review.tsx` — Watermark section; CSS preview overlay; settings↔UI↔export wiring (export invokes at `:424`, `:2412`, `:2456`).

### UI
- On open: `invoke get_settings` → state `{ logoPath, corner, apply }`. `apply` initial = `logoPath set && file present`. **`apply` is local per-recording, never persisted.**
- File row: filename when set; **Change…** (`plugin-dialog open({filters:[png]})` → `set_watermark_logo` → updates global + state, `apply=true`); **Remove** (`clear_watermark_logo` → global cleared, `logoPath=null`, `apply=false`).
- Corner radios TL/TR/BL/BR (default TR) → on change set state + `set_watermark_corner` (updates global).
- **Apply watermark** checkbox → toggles `apply` local only, no invoke.
- Export wiring: every path sends `watermark_logo = (apply && logoPath) ? logoPath : null`, `watermark_corner = corner`.

### "Apply off" — precise semantics
Disables the watermark for **THIS recording only**. The global `settings.json` is **unchanged** — `logo_path` + `corner` persist, so the next recording opens with **Apply back ON** and the logo still set. Only **Remove** clears the global setting. (Apply never writes to disk; Change/Remove/corner-change do.)

### Preview states
- **(a) No logo set:** no overlay; section shows "No logo chosen" + Choose…; corner radios + Apply inert/hidden.
- **(b) Logo set + Apply on:** `<img src={convertFileSrc(logoPath)}>` over the video at `corner`, sized 10% of the rendered video's shorter dimension, 2% padding — WYSIWYG vs export.
- **(c) Logo set + Apply off:** **no overlay** (clean video, matching the no-watermark export); the filename + unchecked Apply still shown so the user sees a logo is remembered but skipped.

Overlay renders iff `apply && logoPath && fileLoads` (img `onerror` → hide + treat as no-logo). Positioned against the video's **rendered content box** (handle object-fit letterboxing when panel aspect ≠ video aspect) so it tracks the actual frame, not the element box.

### Done-when
- Section renders; Change/Remove/corner/Apply behave per above.
- Preview matches states (a)/(b)/(c); overlay placement matches the exported file (manual GUI check: record → pick verification logo → export → compare).
- **Apply off** → that clip exports with no watermark; a fresh recording defaults Apply on with the remembered logo.
- **Remove** → `settings.json` `logo_path` null + `watermark.png` gone; later recordings open with no logo.
- All four export buttons pass the watermark args.
- **Same-corner-as-webcam-bubble overlap check:** record with the webcam bubble in bottom-right, set watermark to bottom-right, export — confirm the export does not fail and the file is valid (ffprobe ok + plays). Visual overlap is acceptable (user's choice); a broken/corrupt file is not.
- **Preview tracking at three window sizes** (object-fit:contain edge cases — where overlays usually break): verify the overlay stays glued to the video frame's corner when the panel (a) matches the video aspect, (b) is wider than the video (vertical letterbox bars left/right), and (c) is narrower than the video (horizontal letterbox bars top/bottom).

### Commit
`feat(watermark c3): review-window watermark section + live WYSIWYG preview`

---

## Risk / dependency notes

- c1 and c2 touch disjoint files and are independently buildable; c3 depends on c1 (settings commands) + c2 (export args). Recorded order c1 → c2 → c3.
- The watermark sits on top of the already-composited webcam bubble (the scratch mp4 is composited at finalize); same-corner overlap is a user choice, validated for file integrity in c3.
- GIF palette quantization may lightly posterize the logo (accepted per CONTEXT).

---

*Feature: watermark-review-window*
*Plan drafted: 2026-05-28*
