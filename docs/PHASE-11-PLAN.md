# Phase 11 — Review window UX overhaul: unified export + timeline scrubbing — Plan

**Drafted:** 2026-05-19
**Status:** Ready to execute
**Source of truth for decisions:** `docs/PHASE-11-CONTEXT.md`

Two coupled deliverables in the review window:

- **Unified export flow** — collapse the footer Save action and the sidebar Quick Export section into one format-selector Save block; eliminate the disabled MP4/ProRes stubs. Save unifies "produce file in `~/Movies/Zeigen/`" across MP4 and GIF.
- **Timeline scrubbing** — track-anywhere drag-to-scrub + hover/drag frame preview backed by a pre-generated thumbnail sprite.

Six atomic commits, three backend → three frontend.

## Save model

The scratch dir (`~/Movies/Zeigen/.scratch/<stamp>/`) survives the entire review session. Raw scratch mp4 + sidecar JSON remain editable throughout — no separate baked canonical, no edit-lock at first save.

Every save reads `raw scratch + current sidecar` and produces an output in `~/Movies/Zeigen/`. The scratch dir is removed only when the review window closes (red X, Record another, Discard, app close — same cleanup trigger as today). After close the recording is locked; re-saving at a different resolution requires re-recording.

### Pipeline pass counts per save

| Sidecar | Format | Resolution | Passes |
|---|---|---|---|
| noop | MP4 | Source | 0 (hard-link raw → Movies, copy fallback) |
| noop | MP4 | 480p / 720p / 1080p | 1 (raw → Movies @ res) |
| noop | GIF | any | 1 (raw → Movies.gif) |
| with edits | MP4 | Source | 1 (raw + sidecar → Movies) |
| with edits | MP4 | 480p / 720p / 1080p | 1 (raw + sidecar → Movies @ res) |
| with edits | GIF | any | 1 (raw + sidecar → Movies.gif) |
| subsequent saves | any | any | same as above (re-reads raw + current sidecar; goes to next collision slot) |

Same-format collision suffix: `recording-<stamp>.mp4`, `-2.mp4`, `-3.mp4`. Per-format scope; saving GIF after MP4 writes `recording-<stamp>.gif` (no collision, different extension).

## Backend — `src-tauri/src/`

### c1: `Mp4Resolution` + scale node in `run_edit_pipeline`

`edit.rs`. Add to the existing `PipelineMode`:

```rust
#[derive(Clone, Copy, Debug)]
pub(crate) enum Mp4Resolution { P480, P720, P1080, Source }

#[derive(Clone, Copy, Debug)]
pub(crate) enum PipelineMode {
    Mp4 { resolution: Mp4Resolution },
    Gif { resolution: GifResolution, fps: u32 },
}
```

- Force-build the filter graph in MP4 mode whenever `resolution != Source` (same shape as the existing `gif_mode` force).
- Scale node appended after the overlay chain, before the tail:
  - `P480` → `scale=-2:480:flags=lanczos`
  - `P720` → `scale=-2:720:flags=lanczos`
  - `P1080` → `scale='min(iw,1920)':-2:flags=lanczos`
  - `Source` → no scale node, no graph forced
- `is_edit_pipeline_noop` now requires `resolution == Source` in addition to "no edits."
- Existing `commit_recording` callers pass `Mp4Resolution::Source` (preserves behavior; `commit_recording` removed in c2).

**Done-when (regression-proof, Phase 10 c1 method).** Same scratch + same sidecar (trim + text + arrow) on `Source` resolution before and after c1: `ffprobe -show_entries frame=pkt_pts_time,pict_type,pkt_size -of csv` matches. Smoke: `Mp4 { P720 }` output is 720 tall with edits baked.

### c2: `save_recording` command + Copy pipeline pass + cleanup of replaced commands

`edit.rs`. Replaces `commit_recording` (lib.rs:447-494) and `gif_export` (edit.rs:672-707).

```rust
#[derive(Serialize)]
pub struct SaveResult {
    pub output_path: String,
}

#[tauri::command]
pub fn save_recording(
    stamp: String,
    source_path: String,        // raw scratch path, every call
    format: String,             // "mp4" | "gif"
    resolution: String,         // "480p" | "720p" | "1080p" | "source"
    fps: Option<u32>,           // required when format == "gif"
) -> Result<SaveResult, String>
```

**Behavior**

1. Resolve next per-format collision slot in `~/Movies/Zeigen/`.
2. Parse `resolution` → enum; parse `format` → branch.
3. Read sidecar adjacent to `source_path` (the raw scratch — same path used by every other command).
4. **MP4 path:**
   - If `is_edit_pipeline_noop(sidecar) && resolution == Source` → `std::fs::hard_link(source, output)` with `std::fs::copy` fallback. 0 ffmpeg.
   - Else → `run_edit_pipeline(source, output, sidecar, Mp4 { resolution })`. 1 ffmpeg.
5. **GIF path:** `run_edit_pipeline(source, output, sidecar, Gif { resolution, fps })`. 1 ffmpeg.
6. **Scratch dir is not touched.** It survives until window close. The sidecar useEffect on the frontend keeps writing to it; edits remain live.

**Update `clipboard.rs::clipboard_copy_recording`** to run the pipeline instead of `std::fs::copy` so Copy honors current edits:
- Read sidecar adjacent to source.
- `run_edit_pipeline(source, temp_dir/file_name, sidecar, Mp4 { resolution: Source })`.
- Write the temp file URL to the pasteboard (unchanged tail).
- Copy stays ephemeral (D-15): no Movies output, no `committedPath` mutation.

**LinkedIn export stays unchanged in Rust.** Frontend chains it (c4).

**Removed in this commit**
- `lib.rs::commit_recording` + its `invoke_handler` registration.
- `edit.rs::gif_export` + its `invoke_handler` registration.
- The `gif_export_baseline` test (it referenced the now-deleted command; the equivalent assertion moves into `save_recording` smoke tests).

**Register** `save_recording` in `lib.rs:614+` invoke_handler.

**Done-when**
- Fresh recording, noop sidecar, MP4-Source save → hard-link, `recording-<stamp>.mp4` in Movies, **scratch dir untouched**.
- Same recording, sidecar gets trim + text + arrow added, MP4-720p save → one pipeline pass, `recording-<stamp>-2.mp4` at 720p with edits baked, scratch untouched.
- Third click GIF-720p-15 → one pass, `recording-<stamp>.gif` with edits baked, scratch untouched.
- User clears the trim in the review window, fourth click MP4-Source → one pass (no longer noop), `recording-<stamp>-3.mp4` reflects the cleared trim.
- Close window → scratch removed; outputs in Movies persist.
- Copy to Clipboard click reflects current sidecar state on pasteboard.

**DECISIONS.md ADRs (written in c2)**

1. **"Save unifies commit + export (D-05); scratch + sidecar stay live until close."**
   The Phase 5.5 scratch dir was originally removed on first commit. Phase 11 defers that cleanup to window-close so every save in the same session can re-read the raw recording + current edits. Trade-off: edits stay editable across saves (a user who saves MP4-720p, watches it, and notices a bad trim can fix the sidecar and re-save without re-recording). Cost: one ffmpeg pass per save, even when the user is only changing resolution. Acceptable — saves are user-initiated, not hot-path; and the "single ffmpeg invocation per save" guideline from CONTEXT line 18 is preserved (every save is exactly one pass).

2. **"MP4 default 1080p."**
   Large-display recordings produce source files (often >3840px wide) that are unwieldy to share. 1080p is the widely-shareable sweet spot and the right default; `Source` remains available for max-quality archival.

### c3: thumbnail sprite + cache sweeps

New `src-tauri/src/thumbs.rs`:

```rust
#[derive(Serialize)]
pub struct ThumbSpriteInfo {
    pub sprite_path: String,
    pub cols: u32, pub rows: u32,
    pub thumb_w: u32, pub thumb_h: u32,
    pub count: u32,
}

#[tauri::command]
pub fn extract_thumb_sprite(
    source_path: String,
    recording_id: String,   // stamp
) -> Result<ThumbSpriteInfo, String>
```

- Single ffmpeg pass: `-i src -vf "fps=N,scale=160:-2,tile=20x10" -frames:v 1 sprite.png`.
- Probe duration → `N = clamp(200.0 / duration, 0.2, 10.0)` so very short clips don't request 1000 fps and very long ones don't gap. Count fits within the 20×10 grid (max 200 thumbs).
- Output: `~/Library/Caches/com.zeigen.app/thumbs/<stamp>.png`.
- Idempotent — re-invocation overwrites. No hit-check this phase (cheap enough).
- `thumbs::sweep_stale_thumbs()` mirrors `exports::sweep_stale_exports`. 24h, best-effort.

**Scratch sweep** (orphan cleanup for crash-mid-session). Add `sweep_stale_scratch()` (in `lib.rs` near `movies_dir`, or a small new `scratch.rs` — planner pick during build, lean inline). Removes `~/Movies/Zeigen/.scratch/recording-*/` dirs older than 24h. Same shape as `exports::sweep_stale_exports`.

**`src-tauri/tauri.conf.json`** asset protocol scope grows by `"$HOME/Library/Caches/com.zeigen.app/thumbs/**"` so `convertFileSrc` can load the sprite PNG.

**Setup wiring** (`lib.rs::run` setup block): call `thumbs::sweep_stale_thumbs()` and `sweep_stale_scratch()` next to the existing `exports::sweep_stale_exports()`.

**Register** `extract_thumb_sprite` in `lib.rs` invoke_handler.

**Done-when.** Devtools `invoke("extract_thumb_sprite", {sourcePath, recordingId})` returns valid `ThumbSpriteInfo`; the PNG opens in Preview as a 20×10 grid of thumbnails. App launch with an orphan `.scratch/<stamp>/` dir older than 24h removes it.

## Frontend — `src/`

### c4: ExportPanel rewrite, footer removal, CloseModal copy update

`src/Review.tsx`.

**Delete**

- `ActionFooter` (1916–2060) and its render in `LeftColumn` (790–798).
- The corresponding props on `LeftColumn` (`onFooterDiscard`, `onFooterSave`, `onFooterRecordAnother`, `onFooterReveal`, `saving`, `committed`).

**Rewrite `ExportPanel`** to the CONTEXT mockup:

```
SAVE
  Format         [ MP4 | GIF ]
  Resolution     [ 480p | 720p | 1080p | Source ]    (MP4)
                 [ 480p | 720p | Source ]            (GIF)
  FPS            [ 10 | 15 | 20 ]                    (GIF only, snap show/hide)
  ─────────────
  [  Save as MP4  ]    (label tracks format)
  (Saved ✓ 1.5s flash post-save, then label returns)

OR EXPORT TO…
  Copy to Clipboard         ⌘C
  Export for LinkedIn
  Reveal in Finder              (4th row; post-save only)

──────
  [ Record another ]
  Discard recording   (red ghost, bottom; disabled post-save)
```

**State (in ExportPanel)**

- `format: "mp4" | "gif"` (default `"mp4"`).
- `mp4Res: "480p" | "720p" | "1080p" | "source"` (default `"1080p"`, D-07).
- `gifRes: "480p" | "720p" | "source"` (default `"720p"`, D-08).
- `gifFps: 10 | 15 | 20` (default `15`, D-09).
- `saving`, `lastSavedAt` (1.5s flash, mirrors `linkedinExportedAt` shape at 2256).

**State (lifted to the Review parent)** — replaces the existing `committedPath`/`committedPathRef` pair, since the meaning shifts under the new model:

- `committedPath: string | null` — most recent `output_path` returned by `save_recording`. Drives:
  - Reveal row visibility (`committedPath != null`).
  - Reveal target (Reveal points to `committedPath`).
  - "Any save happened" gate for the close-window-modal (modal fires when `null`, silent close when non-null).
  - Discard enabled iff `!busy && committedPath == null`.
- The `committedPathRef` semantics around "the recording is committed; subsequent calls return cached path" go away — every save is independent and re-reads scratch.

**Save handler (single `onSave`)**

```ts
const onSave = async () => {
  if (saving || !sourcePath) return;
  setSaving(true);
  try {
    const result = await invoke<SaveResult>("save_recording", {
      stamp,
      sourcePath,
      format,
      resolution: format === "mp4" ? mp4Res : gifRes,
      fps: format === "gif" ? gifFps : undefined,
    });
    setCommittedPath(result.output_path);
    setLastSavedAt(Date.now());
  } catch (err) {
    setError(`save: ${err}`);
  } finally {
    setSaving(false);
  }
};
```

⌘S keyboard shortcut mirrors the existing ⌘C handler at 2365–2380 (skip when in inputs / contentEditable / with selection).

**LinkedIn handler (D-16 "the recording is saved and Reveal appears")**

Chains save_recording → linkedin_export in JS so `linkedin.rs` stays unchanged:

```ts
const onLinkedinExport = async () => {
  // 1. Commit: produce recording-<stamp>[-N].mp4 with current edits baked.
  const save = await invoke<SaveResult>("save_recording", {
    stamp, sourcePath, format: "mp4", resolution: "source",
  });
  setCommittedPath(save.output_path);
  // 2. Transcode the just-saved mp4 to LinkedIn-shape.
  const linkedinPath = await invoke<string>("linkedin_export", {
    stamp, sourcePath: save.output_path,
  });
  // …clipboard caption + openUrl + revealItemInDir as today.
};
```

`linkedin_export` reads the just-baked mp4 (output_path from save_recording) so edits are honored. linkedin.mp4 overwrites on repeat clicks. Repeated LinkedIn clicks accumulate `recording-<stamp>-N.mp4` files — flagged in Deferred Ideas for a future cleanup polish.

**Copy handler** unchanged on the JS side — `clipboard_copy_recording` now runs the pipeline internally (c2). Doesn't commit (D-15), doesn't touch `committedPath`.

**Discard handler**
- Pre-save: `cleanupScratchAndExports()` + `closeWindow()`. Same as today.
- Post-save: button disabled.

**Record another** unchanged — `cleanupScratchAndExports()` + `fireRecordAnother()` + `closeWindow()`.

**CloseModal copy update** (Review.tsx:2106-2112). The current copy says "Saving moves it to ~/Movies/Zeigen" — under the new model, save *copies/transcodes* and the scratch survives until close. Replace with:

```
Save your recording?
You haven't saved this recording yet. Save to put a copy in ~/Movies/Zeigen.
Discarding deletes the recording.
```

Modal still fires only pre-first-save (committedPath == null).

**Done-when**

- Sidebar matches the CONTEXT mockup at every state combination (MP4 selected vs GIF; pre vs post first save).
- Pre-first-save MP4-1080p save → `recording-<stamp>.mp4` at 1080p in Movies; scratch untouched; Saved ✓ flashes; Reveal row appears.
- Second click GIF-720p-15 → `recording-<stamp>.gif` in Movies; Reveal now targets the gif.
- User changes the trim, third click MP4-Source → `recording-<stamp>-2.mp4` reflects the new trim.
- Copy to Clipboard during the same session pastes an mp4 with the current sidecar baked (edits visible in the pasted file).
- LinkedIn click on a fresh recording produces both `recording-<stamp>.mp4` and `recording-<stamp>-linkedin.mp4`; Safari opens, Finder reveals.
- Discard pre-save removes scratch + closes; Discard post-save disabled.
- Close window pre-save fires the modal with the new copy; close post-save silent.
- ⌘S works; ⌘C works.
- Trim handles, annotation pips, Text/Arrow tools remain interactive throughout (no post-save lock).

### c5: track-anywhere drag-to-scrub

`Timeline` component (Review.tsx:1622+).

**Replace `onClick={onTrackClick}` (1723) with `onPointerDown`** on the track div.

```ts
const onTrackPointerDown = (e: React.PointerEvent) => {
  if (duration == null) return;
  const track = trackRef.current!;
  const rect = track.getBoundingClientRect();
  const startX = e.clientX;
  const wasPlaying = !videoRef.current?.paused;
  let movedPastThreshold = false;
  const seekAt = (clientX: number) =>
    seek(((clientX - rect.left) / rect.width) * duration);
  const onMove = (ev: PointerEvent) => {
    if (!movedPastThreshold && Math.abs(ev.clientX - startX) > 3) {
      movedPastThreshold = true;
      if (wasPlaying) videoRef.current?.pause();
    }
    if (movedPastThreshold) seekAt(ev.clientX);
  };
  const onUp = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (!movedPastThreshold) seekAt(ev.clientX);              // pure click
    else if (wasPlaying) videoRef.current?.play().catch(() => {});
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
};
```

- 3px click-vs-drag threshold.
- Trim handles (1879-1913) gain `e.stopPropagation()` on their pointerdown. Without it, grabbing a handle would double-fire the track handler. Annotation pips already stop propagation (1774).
- Playhead `pointerEvents: "none"` preserved (1858). No per-element hover cursor affordance — track-wide `cursor: pointer` is the affordance. (Deferred polish in Deferred Ideas.)

**Done-when.** Drag from anywhere on the track scrubs the video in real time. Click without movement past the threshold seeks. Grabbing a trim handle moves only the handle. Pip drag moves only the pip. Pause-on-grab works from any track location; playback resumes on release iff it was playing pre-grab.

### c6: ScrubPreview component

New `src/ScrubPreview.tsx`. Mirrors `Waveform.tsx` shape — self-contained, owns its own extraction lifecycle.

**Props**

```ts
type Props = {
  assetUrl: string | null;
  recordingId: string | null;       // stamp
  sourcePath: string | null;        // for extract_thumb_sprite
  duration: number | null;
  hoverTime: number | null;         // null hides
  trackRect: DOMRect | null;        // for cursor positioning
};
```

**Lifecycle**

- On mount with `sourcePath` + `recordingId`: invoke `extract_thumb_sprite`. Store `{spriteUrl, cols, rows, thumb_w, thumb_h, count}` on success; `null` on failure.
- **Off-screen `<video>` fallback** while sprite is null. Hidden `<video src={assetUrl} muted preload="auto"/>` ref. On `hoverTime` change: `video.currentTime = hoverTime; await onseeked; ctx.drawImage(video, …)` onto a shared canvas. No per-frame allocation.

**Render**

- Floating div, absolute-positioned by parent (Timeline) using `hoverTime + trackRect`. Z-index above the track.
- Anchor: ~10px above the track, horizontally centered on cursor x, clamped to `[0, viewportWidth - thumbWidth]`.
- Visual: 160×90 thumb painted via `background-image: url(spriteUrl); background-position: -(col*160)px -(row*90)px` where `(col, row) = indexFor(hoverTime)`. Timestamp `mm:ss` label below (Loom/YouTube convention).
- During canvas fallback: render `<canvas>` in place of the background-image div.

**Integration in Timeline (Review.tsx)**

- Track-level `onPointerMove` (hover) + `onPointerLeave`. Compute `hoverTime` from `clientX` relative to `trackRef`.
- During the c5 drag, the existing window-level pointermove also updates `hoverTime` — D-22 coexistence (thumb follows cursor while main video updates).
- Hide on pointerleave.

**Done-when.** Review opens on a fresh recording → sprite extracts in background. Hovering the track shows a 160×90 thumb with `mm:ss` label tracking the cursor. Dragging the timeline (c5) scrubs the main video AND the thumb follows. With sprite-extraction still in flight, the canvas fallback renders frames with visible seek latency (acceptable). Pointerleave hides the preview.

## Build order

| # | Change | Done-when |
|---|---|---|
| c1 | `edit.rs` — `Mp4Resolution` + scale node + noop guard | Frame-metadata equivalent on Source path; MP4-720p output is 720 tall. |
| c2 | `save_recording` command + `clipboard_copy_recording` pipeline pass + delete `commit_recording` & `gif_export` | Save/Copy behaviors above; scratch dir untouched until close; DECISIONS.md ADRs landed. |
| c3 | `thumbs.rs` + scratch sweep + asset-protocol scope + setup wiring | Devtools sprite extraction works; orphan scratch dirs >24h cleaned at launch. |
| c4 | `ExportPanel` rewrite + footer deletion + CloseModal copy + LinkedIn JS chain | Sidebar matches mockup; MP4+GIF saves produce expected files; LinkedIn produces both files; Discard/Reveal/Record-another all behave per spec. |
| c5 | Track-anywhere drag-to-scrub + trim-handle stopPropagation | Drag anywhere scrubs; click-vs-drag threshold honored; pause-on-grab + resume-on-release. |
| c6 | `ScrubPreview.tsx` + Timeline integration | Hover + drag both show the floating thumb; canvas fallback covers sprite-not-yet-ready case. |

## Files touched

- `src-tauri/src/edit.rs` — `Mp4Resolution`, `PipelineMode::Mp4 { resolution }`, scale node, `save_recording`, removed `gif_export`.
- `src-tauri/src/clipboard.rs` — `clipboard_copy_recording` runs `run_edit_pipeline` instead of `std::fs::copy`.
- `src-tauri/src/thumbs.rs` — new file: `extract_thumb_sprite`, `sweep_stale_thumbs`.
- `src-tauri/src/lib.rs` — register `save_recording` + `extract_thumb_sprite`; unregister `commit_recording` + `gif_export`; delete `commit_recording`; add `sweep_stale_scratch`; call thumbs + scratch sweeps from `setup()`.
- `src-tauri/src/linkedin.rs` — unchanged.
- `src-tauri/tauri.conf.json` — asset-protocol scope adds `$HOME/Library/Caches/com.zeigen.app/thumbs/**`.
- `src/Review.tsx` — `ExportPanel` rewrite, `ActionFooter` deletion, Timeline pointer handlers, ScrubPreview integration, trim-handle stopPropagation, CloseModal copy.
- `src/ScrubPreview.tsx` — new file.
- `docs/DECISIONS.md` — two ADR entries (Save-unification model; MP4 1080p default).

## Discretion picks captured here

- ~200 thumbs at 160×90, tiled 20×10 (fps clamped 0.2–10 from duration).
- Timestamp overlay on preview: yes.
- FPS row snap (no animation) on format change.
- ⌘S Save shortcut: yes.
- Click-vs-drag threshold: 3px.
- Playhead cursor: track-wide `cursor: pointer` (no per-element hover affordance — deferred).
- "OR EXPORT TO…" header static across pre/post commit.
- ScrubPreview: ~10px above track, clamped to viewport.
- New components: `ScrubPreview.tsx` lives in its own file; the rewritten `ExportPanel` stays inline in `Review.tsx` (net-smaller after Quick Export removal).
- Noop MP4-Source first save: `std::fs::hard_link` with `std::fs::copy` fallback.

## Deferred (per CONTEXT + new)

- ProRes format — its own phase.
- Save-As dialog (file picker) — auto-save to `~/Movies/Zeigen/` preserved.
- Settings persistence across app restarts — format/resolution/FPS reset on launch.
- Timestamp overlay variants on preview.
- Multi-save Reveal disambiguation (currently points at most recent).
- Per-thumb resolution tuning beyond 160×90.
- SAVE-block visual compression post-commit.
- Trim-handle snap-to-peaks (Phase 10 deferred).
- Waveform zoom (Phase 10 deferred).
- WebP / animated WebP (Phase 10 deferred).
- Playhead-hover ew-resize affordance (Phase 11 discretion — skipped; backlog if needed).
- Repeated-LinkedIn-click MP4 accumulation cleanup — each LinkedIn click currently produces a fresh `recording-<stamp>-N.mp4` alongside the overwritten `-linkedin.mp4`. Could be addressed by detecting a recent same-sidecar save and reusing it; defer until annoying.

---

*Phase: 11-review-window-ux-overhaul*
*Plan drafted: 2026-05-19*
