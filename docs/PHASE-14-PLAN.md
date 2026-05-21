# Phase 14 — Final v1.0 polish — Plan

**Drafted:** 2026-05-21
**Status:** Ready to execute
**Source of truth for decisions:** `docs/PHASE-14-CONTEXT.md`

Two independent commits, ordered smallest-blast-radius first (Phase 12 / Phase 13 precedent):

- **c1 — Webcam bubble placement fix** (14.1). `src/App.tsx` only — single file region. `openBubble` refactor to plant via `set_window_frame_cg`; effect deps extend to include `selectedDisplay` / `selectedWindow`; move-if-off-screen re-anchor logic. No Rust changes (existing `set_window_frame_cg` is reused). Smallest commit; independent of c2.
- **c2 — Review preview audio parity** (14.2). New `#[tauri::command]` in `src-tauri/src/edit.rs` + registration in `src-tauri/src/lib.rs`; `src/Review.tsx` fetch + state + `<video>` source swap + status pips. Includes the eager-vs-lazy measurement step (D-08) which gates the frontend lifecycle choice. Biggest commit of the phase.

Each commit is independent and self-verifying. c1 puts the bubble on the right screen at recording-target picker time; c2 lets the user audibly verify NR before saving.

---

## c1 — Webcam bubble placement fix

`src/App.tsx`. Single-file region.

### File region

- `openBubble` at lines 25-93 (placement plumbing change).
- The bubble-lifecycle effect at lines 1324-1342 (deps extension + anchor source).

### Placement plumbing refactor (D-02)

Mirror `openCountdown` (lines 111-168). The bubble's window construction stops carrying placement in the constructor's `x`/`y`/`width`/`height` arguments; placement runs through `set_window_frame_cg` on `tauri://created` alongside the existing `make_capture_invisible` invocation.

```ts
// Build anchor rect in CG points. Caller passes a rect (display, window,
// or area); openBubble doesn't decide which — that's the effect's job.
type BubbleAnchor = { x: number; y: number; w: number; h: number };

async function openBubble(deviceName: string, anchor: BubbleAnchor) {
  // ... existing dedupe / close-existing logic unchanged ...

  // Primary display Cocoa height for the CG -> Cocoa flip in
  // set_window_frame_cg. Same lookup the countdown overlay uses.
  const monitors = await availableMonitors();
  const primary =
    monitors.find((m) => m.position.x === 0 && m.position.y === 0) ||
    monitors[0];
  const primaryCocoaHeight =
    primary && primary.scaleFactor
      ? primary.size.height / primary.scaleFactor
      : 1080;

  // Bubble target rect: bottom-right of the anchor with BUBBLE_MARGIN.
  const targetX = anchor.x + anchor.w - BUBBLE_W - BUBBLE_MARGIN;
  const targetY = anchor.y + anchor.h - BUBBLE_H - BUBBLE_MARGIN;

  const win = new WebviewWindow(BUBBLE_LABEL, {
    url: `/#bubble?name=${encodeURIComponent(deviceName)}`,
    title: "Webcam",
    // Initial size + position don't matter — set_window_frame_cg below
    // resizes + places post-create. Same pattern as openCountdown.
    width: BUBBLE_W,
    height: BUBBLE_H,
    minWidth: BUBBLE_MIN,
    minHeight: BUBBLE_MIN + PILL_STRIP_CSS,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    visibleOnAllWorkspaces: true,
    shadow: false,
  });

  win.once("tauri://created", async () => {
    try {
      await invoke("set_window_frame_cg", {
        label: BUBBLE_LABEL,
        cgX: targetX,
        cgY: targetY,
        width: BUBBLE_W,
        height: BUBBLE_H,
        primaryCocoaHeight,
      });
      await invoke("make_capture_invisible", { label: BUBBLE_LABEL });
    } catch (e) {
      console.error("bubble setup failed", e);
    }
  });
  win.once("tauri://error", (e) => {
    console.error("bubble window error", e);
  });
}
```

`BubbleAnchor` becomes a required parameter — the null-anchor fallback inside `openBubble` is removed. Callers always pass a rect; "no anchor" is the caller's problem to solve (handled in the effect, D-01).

### Anchor source in the effect (D-01, D-04)

The effect at lines 1324-1342 builds the anchor rect from the user's source pick.

```ts
useEffect(() => {
  if (!cameraName) {
    closeBubble().catch(() => {});
    return;
  }
  let anchor: BubbleAnchor | null = null;

  if (sourceKind === "area" && selectedArea) {
    const d = displays.find((x) => x.id === selectedArea.display_id);
    if (d) {
      anchor = {
        x: d.x + selectedArea.x,
        y: d.y + selectedArea.y,
        w: selectedArea.width,
        h: selectedArea.height,
      };
    }
  } else if (sourceKind === "display" && selectedDisplay != null) {
    const d = displays.find((x) => x.id === selectedDisplay);
    if (d) {
      anchor = { x: d.x, y: d.y, w: d.width, h: d.height };
    }
  } else if (sourceKind === "window" && selectedWindow) {
    // Window mode: anchor to the captured window's current frame.
    // selectedWindow already carries x/y/w/h in CG points (see
    // engine_start payload at line 1001-1006). Bubble lands at the
    // window's bottom-right; IPC window-frame updates (5Hz) take over
    // for follow-during-recording.
    anchor = {
      x: selectedWindow.x,
      y: selectedWindow.y,
      w: selectedWindow.width,
      h: selectedWindow.height,
    };
  }

  // Fallback: no source picked yet (e.g. cameraName set but
  // selectedDisplay still null). Place on the primary display's
  // bottom-right; D-03's re-anchor effect will correct it as soon as
  // the user picks a source.
  if (!anchor) {
    const m = displays[0];
    if (m) anchor = { x: m.x, y: m.y, w: m.width, h: m.height };
  }

  if (anchor) {
    openBubble(cameraName, anchor).catch((err) => setError(String(err)));
  }
}, [cameraName, sourceKind, selectedArea, selectedDisplay, selectedWindow, displays]);
```

Field names for `selectedWindow` (`x`, `y`, `width`, `height` vs other shapes) need confirming against the actual state type at edit time — keep this snippet's shape but pin to whatever the type definition uses.

### Move-if-off-screen re-anchor (D-03)

The effect above already fires on every picker change because `selectedDisplay` / `selectedWindow` are now in deps. When the bubble already exists (`bubbleDeviceName === deviceName` branch in `openBubble`), today's code calls `existing.show()` and returns — no re-placement. Replace that early-return with the move-if-off-screen check:

```ts
async function openBubble(deviceName: string, anchor: BubbleAnchor) {
  const existing = await WebviewWindow.getByLabel(BUBBLE_LABEL);

  if (existing && bubbleDeviceName === deviceName) {
    // Same camera, anchor may have changed (picker switch). Decide
    // whether to re-place by intersection with the new anchor's rect.
    const scale = await existing.scaleFactor();
    const pos = await existing.outerPosition();
    const size = await existing.outerSize();
    const cur = {
      x: pos.x / scale,
      y: pos.y / scale,
      w: size.width / scale,
      h: size.height / scale,
    };
    const intersects =
      cur.x + cur.w > anchor.x &&
      cur.x < anchor.x + anchor.w &&
      cur.y + cur.h > anchor.y &&
      cur.y < anchor.y + anchor.h;
    if (intersects) {
      await existing.show().catch(() => {});
      return;
    }
    // Off-screen vs the new target — re-place to the anchor's
    // bottom-right corner. Same set_window_frame_cg path as creation.
    const monitors = await availableMonitors();
    const primary =
      monitors.find((m) => m.position.x === 0 && m.position.y === 0) ||
      monitors[0];
    const primaryCocoaHeight =
      primary && primary.scaleFactor
        ? primary.size.height / primary.scaleFactor
        : 1080;
    const targetX = anchor.x + anchor.w - BUBBLE_W - BUBBLE_MARGIN;
    const targetY = anchor.y + anchor.h - BUBBLE_H - BUBBLE_MARGIN;
    await invoke("set_window_frame_cg", {
      label: BUBBLE_LABEL,
      cgX: targetX,
      cgY: targetY,
      width: BUBBLE_W,
      height: BUBBLE_H,
      primaryCocoaHeight,
    }).catch((e) => console.error("bubble re-anchor failed", e));
    await existing.show().catch(() => {});
    return;
  }

  // Different camera or no existing — close + recreate path (today's
  // existing behavior).
  if (existing) await existing.close().catch(() => {});
  bubbleDeviceName = deviceName;
  // ... fall through to the create-with-set_window_frame_cg path above.
}
```

Bubble window dimensions only change if the user has resized via the ring handle — `BUBBLE_W` / `BUBBLE_H` (constants from line 15-16) are the initial-size source. The re-anchor path uses the *current* size, not the constants, for the rect-width subtraction. Adjust if the implementation diverges from the snippet.

### Done-when

- Pick the camera, then pick a non-primary screen in the source picker (Display 2 / Display 3) → bubble appears on the picked screen, not Display 1.
- Pick a screen-left-of-primary (negative-x screen) → bubble appears there. (If no such screen is available in your setup, skip this check.)
- Pick a window in window mode → bubble lands at the captured window's bottom-right, inside the recorded frame.
- Pick an area → bubble lands at the selected region's bottom-right (no regression vs today).
- Open the bubble, then switch the screen picker to a different display whose bounds *do* contain the bubble's current rect → bubble stays put.
- **Edge case (load-bearing):** open the bubble on display A, drag it deep into A's bottom-right, then switch the picker to display B such that the bubble's current rect has zero overlap with B's bounds → bubble moves to B's bottom-right corner with `BUBBLE_MARGIN`. This is the primary win of the re-anchor logic; verify it explicitly.
- Switch picker back and forth several times rapidly → no flicker, no double-windows, no half-size landings.
- Bubble drag + resize still work; corner snap (`useCornerSnap`) still works; position log still writes (`useBubblePositionLog`).
- `make_capture_invisible` still applies — bubble doesn't appear in a recording made on the picked screen.

### Verification fixture

Manual UAT on a multi-display setup. The bug requires at least two physical displays; ideally one to the left of the primary (negative-x coords) to exercise the constructor-bug path that `set_window_frame_cg` is meant to handle. DisplayLink-driven displays carry the existing DECISIONS.md 2026-04-26 caveat — placement on those is unreliable independent of Phase 14.

---

## c2 — Review preview audio parity

`src-tauri/src/edit.rs` + `src-tauri/src/lib.rs` + `src/Review.tsx`. Consumes the existing arnndn pipeline.

### Step 0 — Measure arnndn pass time (D-08)

Before writing UI, measure how long the existing arnndn pipeline takes on a representative scratch. Use the Phase 13 c3 baseline (`recording-2026-05-19-114549`) or a fresh 1-2 min take. Measurement is about typical-case timing, not edge-case reproduction — any normal-speech recording is fine. Two ways to measure:

**Option A:** Run the existing save pipeline against a copy of the scratch, time the call. (Approximates real cost.)

**Option B:** Stand up the preview command (below) and time it directly.

Pick the simpler one. Threshold:

- **<2s → eager.** Run preview generation at review-open; block the `<video>` source swap on it. UI shows the normal review-open delay (same window as thumb-sprite extraction, which the user already accepts).
- **≥2s → lazy.** Run preview generation at review-open in the background; raw scratch plays until preview is ready, then swap. Show a "Preview generating…" status pip during the wait.

Record the measurement in the commit message. The pipeline below works for both paths — the difference is purely when the frontend invokes it and what surface it shows during generation.

### Preview command shape (D-06, D-07, D-09)

New public function + `#[tauri::command]` wrapper in `src-tauri/src/edit.rs`, alongside the existing `probe_audio_track` from Phase 13.

```rust
#[tauri::command]
pub fn render_preview_audio(source_path: String) -> Result<String, String> {
    let source = Path::new(&source_path);
    let preview_path = preview_path_for(source)
        .ok_or_else(|| "source not inside .scratch/<id>/".to_string())?;
    render_preview_audio_path(source, &preview_path)?;
    Ok(preview_path.to_string_lossy().into_owned())
}

// Resolve the preview-file path for a scratch source. Source is expected
// to live at .scratch/<id>/recording-<stamp>.mp4 (or similar); preview
// lands as a sibling.
pub(crate) fn preview_path_for(source: &Path) -> Option<PathBuf> {
    source.parent().map(|p| p.join("preview.mp4"))
}

pub(crate) fn render_preview_audio_path(source: &Path, output: &Path) -> Result<(), String> {
    // Drop any stale preview from a prior open. Regenerate fresh.
    let _ = std::fs::remove_file(output);

    let args = [
        OsStr::new("-y"),
        OsStr::new("-i"), source.as_os_str(),
        OsStr::new("-af"), OsStr::new(&format!("arnndn=m={}", audio_model_path().display())),
        OsStr::new("-c:v"), OsStr::new("copy"),
        OsStr::new("-c:a"), OsStr::new("aac"),
        OsStr::new("-b:a"), OsStr::new("192k"),
        OsStr::new("-map"), OsStr::new("0:v:0"),
        OsStr::new("-map"), OsStr::new("0:a:0?"),
        output.as_os_str(),
    ];

    let result = Command::new(FFMPEG_PATH)
        .args(args)
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg for preview: {e}"))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!(
            "ffmpeg preview render failed (exit {:?}):\n{}",
            result.status.code(),
            stderr.lines().rev().take(40).collect::<Vec<_>>()
                .into_iter().rev().collect::<Vec<_>>().join("\n")
        ));
    }

    Ok(())
}
```

The `OsStr` shape mirrors the format args helper already in use in `edit.rs`; if the existing pattern uses `String` args, match that. The pipeline is intentionally the narrowest possible slice of the existing save pipeline — same `-af arnndn=m=…`, same `-c:a aac -b:a 192k`, video stream copied. No trim, no overlay, no `-c:v` re-encode.

Note the `audio_model_path()` reuse — same model resolver the save pipeline uses (Phase 12 c3 wiring in `lib.rs:540-550`). The model path is set at app startup; by the time review opens, it's available.

### Registration

In `src-tauri/src/lib.rs::invoke_handler![…]` (line ~616), add `edit::render_preview_audio` alongside the existing `edit::*` entries (including `edit::probe_audio_track` from Phase 13).

### Test

`#[ignore]` baseline test against the Phase 13 c3 scratch fixture, mirroring `probe_audio_track_baseline`.

```rust
#[test]
#[ignore]
fn render_preview_audio_baseline() {
    let home = std::env::var("HOME").unwrap();
    let source_str = format!(
        "{home}/Movies/Zeigen/.scratch-baseline-c1/recording-2026-05-19-114549/recording-2026-05-19-114549.mp4"
    );
    let source = Path::new(&source_str);
    assert!(source.exists(), "baseline source missing");

    let preview = source.parent().unwrap().join("preview.mp4");
    let _ = std::fs::remove_file(&preview);

    let start = std::time::Instant::now();
    render_preview_audio_path(source, &preview).expect("render preview");
    let elapsed = start.elapsed();

    assert!(preview.exists(), "preview file not created");

    let src_dur = probe_duration_seconds(source).expect("source duration");
    let prev_dur = probe_duration_seconds(&preview).expect("preview duration");
    println!(
        "preview render: {:.2}s wall-clock for {:.2}s recording (preview={:.2}s)",
        elapsed.as_secs_f64(), src_dur, prev_dur,
    );
    // Audio re-encode + video copy should preserve duration within
    // a frame.
    assert!((src_dur - prev_dur).abs() < 0.1, "duration mismatch");

    // Verify the audio stream actually changed (arnndn ran).
    // Compare audio md5 against source. Optional but useful — left
    // as a follow-up if the existing edit_pipeline_noop_save test
    // pattern can be reused.
}
```

The printed elapsed time is the D-08 measurement. Run this once to decide eager vs lazy before the UI implementation.

### Review.tsx wiring

Two paths share the same fetch + state shape; only the trigger differs.

```tsx
// New state in Review's top-level component.
type PreviewState =
  | { status: "idle" }
  | { status: "rendering" }
  | { status: "ready"; url: string }
  | { status: "failed" };

const [previewState, setPreviewState] = useState<PreviewState>({ status: "idle" });

// Effect on sourcePath change. Same lifecycle window as sidecar /
// sprite / audio-meta probes.
useEffect(() => {
  if (!props.sourcePath) {
    setPreviewState({ status: "idle" });
    return;
  }
  let cancelled = false;
  setPreviewState({ status: "rendering" });

  invoke<string>("render_preview_audio", { sourcePath: props.sourcePath })
    .then((previewPath) => {
      if (cancelled) return;
      // convertFileSrc / asset-protocol scope already configured for
      // .scratch/ paths (Phase 5.5 UAT fix); preview lives in the
      // same dir so the same scope covers it.
      const url = convertFileSrc(previewPath);
      setPreviewState({ status: "ready", url });
    })
    .catch((err) => {
      console.warn("preview render failed", err);
      if (!cancelled) setPreviewState({ status: "failed" });
    });

  return () => {
    cancelled = true;
  };
}, [props.sourcePath]);
```

### `<video>` source swap

- **Eager path:** swap `src` to `previewState.url` when `status === "ready"`; until then, the `<video>` has no `src` (or shows a brief loading state).
- **Lazy path:** start with the raw scratch as `src`; when `status === "ready"`, swap to `previewState.url`. The swap mid-playback is jarring — pause + remember `currentTime` + swap + restore + don't auto-play. Tested pattern; if the swap proves bad in UAT, fall back to "swap only on next play" (start with raw, swap on `pause` or on `play` after first cycle).

Pick the path at implementation time based on the D-08 measurement.

### Status pip surfaces (D-08 lazy state + D-10 fallback)

Two pip surfaces in the review chrome. Both use the existing status-pip pattern (suggest: same visual treatment as the existing footer "Saved" indicator).

- **"Preview generating…"** — shown while `previewState.status === "rendering"` in the lazy path. Disappears on "ready" or "failed."
- **"Preview is raw — save still applies NR"** — shown when `previewState.status === "failed"`. Sticky until review closes. The `<video>` continues to play raw scratch.

The exact visual treatment is at Claude's Discretion per CONTEXT — keep it in line with existing pips.

### Cleanup (D-07)

Preview file lives in `.scratch/<id>/preview.mp4` so the existing scratch-lifecycle paths sweep it. No new cleanup code:

- **Discard recording** — `.scratch/<id>/` removed wholesale, takes the preview with it.
- **Save recording** — scratch dir removed after the save pipeline finishes, takes the preview with it.
- **Close review without commit** — close-prompt branch picks Save or Discard, both of which already handle cleanup.
- **App crash mid-review** — orphan preview files sit inside `.scratch/<id>/`. The next review-open removes the prior preview before regenerating (`render_preview_audio_path` opens with `remove_file(output)` first). The existing scratch app-launch sweep covers truly orphaned dirs.

### Done-when

- Open a recording with audible noise (or the 18:04 anomaly recording, if still on disk). Confirm "Preview generating…" status pip is visible during render (lazy path) or that review-open delay matches existing thumb-sprite extraction window (eager path). Play through — audio sounds NR-processed.
- **A/B parity check (load-bearing):** save the recording. Open the saved MP4 from `~/Movies/Zeigen/` in QuickTime. Re-open a fresh recording in review with the same noise profile. Switch between the two — the review preview and the saved MP4 should sound *the same* on the audio. This is the parity guarantee the phase is buying; any audible divergence means preview drifted from the save pipeline.
- Compare raw scratch playback (e.g. open the scratch MP4 directly in QuickTime, bypassing the review window) against the review preview — review preview should be audibly cleaner.
- Open the same recording again (close review, re-open) — preview regenerates fresh, no stale-cache artifacts.
- Discard the recording — preview file gone with the scratch dir.
- Save the recording — preview file gone (scratch dir cleared); saved MP4 in `~/Movies/Zeigen/` is what the A/B check above already verified.
- Force the arnndn pipeline to fail (e.g. corrupt the bundled model briefly) — review still opens, raw scratch plays, "Preview is raw" status pip visible, save still works (export-side NR independent).
- For the lazy path (if D-08 measurement triggered it): preview generation runs without blocking initial review open; status pip appears during the wait; swap occurs cleanly when ready.
- Waveform clipping highlights (Phase 12 c1) still appear in the same positions — the consequence-explicit D-12 asymmetry holds: amber reflects pre-NR signal, audio is post-NR.

### Verification fixture

Three test recordings during c2 verification:

1. **The 18:04 anomaly recording** (if still on disk, may be in `~/Movies/Zeigen/`) — the canonical "NR over-suppressed speech" case. Review preview should make this audible before save. **If not on disk, fall back to any representative recording with normal speech** — don't block on finding this specific file. The parity guarantee (A/B check in done-when) is the load-bearing verification; the 18:04 anomaly is illustrative, not required.
2. **A fresh noisy recording** — make a take in a noisy environment (fan, traffic). Preview audibly cleaner than scratch.
3. **A screen-only-no-mic recording** — render preview anyway; the `arnndn` filter is a no-op when no audio stream exists. Verify the preview file is still produced and plays without audio.

---

## Phase done-when

- Webcam bubble appears on the user-picked recording target, not the primary display (c1 verified).
- Bubble re-anchors when the picker switches to a target the bubble doesn't currently overlap (c1 verified).
- Review playback uses NR-processed audio matching what the save pipeline produces (c2 verified).
- Save pipeline + saved MP4s byte-stable vs Phase 13 baseline (Phase 12 D-01 / Phase 5.5 invariants preserved).
- No regression in bubble drag, corner snap, position log, capture-invisibility, area-mode behavior, IPC window-follow, waveform alignment, clipping highlight, or scratch lifecycle.

## Out of plan (deferred, captured here for traceability)

- WASM RNNoise in browser — rejected (D-06).
- On-demand A/B toggle (raw vs NR in review) — rejected (D-06).
- Full export-pipeline parity in preview (trim + annotations) — out of scope (D-09).
- Settings persistence for bubble position-per-display — out of scope.
- Persistent caching of preview file across review-opens — premature optimization (D-07).
- Waveform regeneration against preview file — rejected (D-12); pre-NR waveform is the right reference for the clipping highlight.
- Mid-record picker-change bubble repositioning — out of scope; engine doesn't accept source change mid-record.
- Capture-side limiter (Phase 12 c3) — separate queued phase. Preview pipeline is forward-compatible (D-11).

All covered in PHASE-14-CONTEXT.md §"Deferred Ideas."

---

*Phase: 14-final-polish*
*Plan drafted: 2026-05-21*
