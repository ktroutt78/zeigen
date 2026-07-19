# Decisions

Append-only log. Newest at top. Don't re-litigate settled decisions — if you want to revisit one, add a new entry that supersedes it.

---

## 2026-07-18 — GIF-with-edits ported to V3 (commit 5 of the V2-elimination arc)

A GIF of a zoomed/webcam/watermarked recording rendered on the V2 machinery (`zoom_filter_fragment` / `build_webcam_overlay` / `composite()`) then palettegen — the last live consumers besides trim (already ported). GIF now splits by whether it needs a render, before `decide_v3` (which is now MP4-only):

- **Edited GIF** (zoom/webcam/watermark) -> `run_v3_gif`: cicompositor renders at SOURCE res (via the shared `v3_render` factored out of `run_v3_export`), then a single ffmpeg palettegen pass. The GifResolution scale is done by the palette pass's own lanczos, not the compositor — byte-identical scale filter to V2's tail.
- **Plain GIF** (incl. trim-only, downscale-only) -> `run_plain_gif`: one-pass ffmpeg palettegen, BYTE-IDENTICAL to V2's single_input GIF (gated by md5). The GIF analog of the plain `-c:v copy` MP4 fast path — survives teardown independently.

Neither enters `run_edit_pipeline_v2`. The palettegen/paletteuse arg string is unchanged from V2 (`stats_mode=diff`, `dither=bayer:bayer_scale=5`); only the frames feeding it moved (through cicompositor + its ~0.18 bits/px H.264 intermediate).

**The palette-path risk and how it resolved.** The feared failure mode: for a zoomed GIF, V2 fed palettegen its frames in the same pass with no re-encode; V3 adds a full H.264 encode/decode hop (yuv420p 4:2:0 + DCT) before the 256-color quantize + bayer dither, which could band flat gradients. **Owner eye-check (2026-07-18) on the built-to-expose-it content — rebalance.mp4's dark-gray map fields + fine bar charts, zoomed 2x on the charts, V3 vs V2 GIFs + matched full-zoom still-PNGs: PASS.** No banding in either; V3's darks came out cleaner (less dither speckle) and visibly sharper (the backing-scale/Core-Image win carries into the GIF). Red-channel check on the hardest case (saturated reds against dark — deficit dots + pills): no posterization, 123 distinct red levels in V3 (137 V2), edges dither cleanly. **The added H.264 hop cost nothing visible.** Decision: ship the simplest-first intermediate (reuse the 0.18 bits/px render); the bitrate reserve lever is NOT needed and stays unused.

Gate (durable, in edit.rs): `gif_plain_path_byte_identical` (md5 vs V2 for plain/trim/480/720), `gif_v3_edited_valid_and_frame_parity` (valid + correct dims + frame-count parity), `gif_v3_multiseg_drift_caveat` (same Continuity-drop caveat an MP4 gets), `gif_dispatch_routing` (plain->run_plain_gif byte-identical, edited->run_v3_gif). The one-shot eye-check render harness was removed after the verdict — it A/B'd against V2, which teardown deletes; scope + this entry record the result. Scope: docs/V2-ELIMINATION-GIF-SCOPE.md.

Next and last: teardown (commit 6) — delete the V2 machinery + `use_v3_compositor` flag, reroute the plain `-c:v copy` MP4 path + `run_plain_gif` to survive byte-exact.

---

## 2026-07-17 — CLASS: values stored in one coordinate space, consumed in another (backing-scale exposed three)

The 1512->3024 backing-scale capture change surfaced a recurring bug class, logged once here rather than three times: **a value written in coordinate space A and read in space B, correct only because A == B while capture happened to equal the frontend's logical space (both 1512). The moment capture became the 2x backing store, every one broke.** All three shipped silently until backing-scale moved the two spaces apart. The pattern to watch: a spatial value that is NOT a fraction and NOT dimensionless. If a fourth appears, it is this.

The three found and fixed:
1. **Cursor telemetry scale** (RecordingSession.swift) — `video_size` doubled to backing px but the cursor mapping `scale` would have stayed 1.0, halving every zoom-focus fraction (focus drifts top-left). Fixed by `captureGeometry()` returning width/height/scale as one coupled triple + a test that fails if they diverge (commit 27d0e11).
2. **LinkedIn export resolution** (Review.tsx) — the direct-LinkedIn path forced `resolution: "source"`, harmless when Source was a 1512-logical capture, a 4K upload once capture went backing (LinkedIn downscales to 1080p anyway). Fixed to 1080p-supersample (commit f3a692c).
3. **Bubble diameter** (this commit) — logged in logical points, consumed as an absolute pixel diameter against the export screen; correct at 1512, half-size at 3024. Preview and export AGREED WITH EACH OTHER while both wrong — the worst failure mode. Fixed by storing a **fraction** of frame width (`diameter_frac`), like x/y already were, resolved to px against the capture width at export.

**Full sidecar audit (owner-requested), so nobody waits for a fourth to surface:** diameter was the ONLY remaining instance. Everything else is safe by being a fraction, a same-space value, or dimensionless — bubble x/y are fractions; **zoom center_x/y are stored AND consumed in capture-pixel space** (detection reads `video_size`, export/preview divide by the source width — same space, they move together, unlike diameter which crossed spaces); trim/thumbnail are seconds; scale/roundness/opacity/watermark scale_frac are ratios; annotations are dead. No fourth in the sidecar.

## 2026-07-17 — Zoom detection thresholds scaled to capture resolution (step 3 of backing-scale)

Backing-scale doubled telemetry pixels (built-in 1512->3024), but `zoom.rs`'s six trigger/merge thresholds (`DWELL_RADIUS_PX`=150, `DRAG_MIN_PX`=60, `CENTER_MERGE_PX`=300, `POST_CLICK_STILL_PX`=60, `PARKED_BBOX_PX`=8, `JITTER_STEP_PX`=5) are absolute pixels. Same physical motion now spans 2x the pixels, so every threshold effectively HALVED — dwells under-detected, drags over-detected, merges rarer. A behavior change wearing a capture change's clothes, which is why the owner insisted on eye-judgment, not blind rescale.

**Fix:** `detect()` scales the six px thresholds by `video_width / REF_VIDEO_WIDTH` (REF = 1512, the built-in's logical width where they were tuned). A 1512 capture is unchanged; a 3024 backing capture doubles them; detection is resolution-independent going forward. This is fraction-of-screen normalization ("cursor stayed within ~10% of the frame"), the correct basis for on-screen gestures. Centers are untouched (telemetry positions consumed as fractions). Everything else in the detector (fit_scale, gesture floors, all time windows) was already ratio/time-based — audited, not scaled.

**Gate (owner eye, on CFR-smooth renders of the real 3024 recording).** Rendered flat-thresholds vs scaled side by side; the ONLY difference on the real recording was a 19-29s stretch (flat = two punches with a pointless zoom-out/in reset; scaled = one continuous hold). Owner chose **scaled**. The 10s opener and everything else were byte-identical.

**Fixture re-pin (honest split):** the two built-in-class fixtures — 091633 (1470) and 220817 (1512) — are UNCHANGED by the scaling (res_scale ~1.0), proving no regression on built-in recordings. 105816 (1920, EXTERNAL display) shifts (res_scale 1.27, thresholds +27%) in its 122-161s tail + a ~70s center; re-pinned to the scaled output but judged by the MODEL (consistent fraction normalization), NOT by eye — its source video is gone, and the eye-judgeable built-in case checked out on real footage. Owner accepted the model-based re-pin (doesn't have an external 1080p display handy; built-in is the case that matters).

## 2026-07-17 — V3 zoom stutter: diagnosed as idle-skip (NOT load-drop), fixed with compositor CFR

Zoomed V3 exports stuttered after backing-scale. Initial read (WRONG, corrected here): backing-scale's 4x pixels made SCK drop frames under load (measured 29->24 fps). **Actual cause: idle-frame skipping.** The recording engine writes only SCK `.complete` frames (`RecordingSession.swift:675`); SCK sends `.idle` frames when the screen is unchanged, which we discard. On a static dashboard that's ~24 fps with gaps to 333ms. The compositor keys the zoom off each frame's PTS (`zoomAt(segs, t)`), so across an idle gap the zoom lurched ~10x a normal step — the stutter. The compositor preserved the VFR 1:1.

**It is NOT a bottleneck and NOT a backing-scale cost — proven:** median frame interval is 33.3 ms = full 30 fps DURING active content (4K30 keeps up); 44/52 gaps >100ms had <10px cursor movement (screen genuinely static); pixel format is already efficient YUV biplanar (not BGRA); the callback does no inline encode (append enqueues in microseconds). So backing-scale carries no hidden frame-rate cost, and the sparse-during-idle capture is correct (it faithfully sampled a static screen), not broken.

**Fix (compositor CFR, main.swift).** Render on a fixed-fps grid instead of 1:1 with the VFR source: for each output tick `tOut = i/fps`, composite the source frame current at `tOut` (held across idle gaps) with `zoom(tOut)`, stamp a regular PTS. So the zoom animates in even 1/fps steps over a held frame during a gap — smooth camera over a momentarily-static screen (a content freeze during a gap is inherent to the dropped capture and separate). `fps` floored at 30 because `nominalFrameRate` under-reports on an idle-skipped VFR file (reported 24 on a 30-target recording) and a grid below the active peak would subsample real motion frames. `alwaysCopiesSampleData = true` so a held frame survives the next read. Verified on the real 3024x1964/46.6s recording: 1399 frames = round(46.62x30), every interval 33.33ms, zero gaps, video dur == audio dur (46.633s). Owner-judged before/after: stutter gone. Cost ~1.2-1.3x export time (the idle-backfill frames; they encode near-free as duplicates).

**Heartbeat ceiling — DO NOT crank it (this is the note so nobody does).** The capture's idle heartbeat (`RecordingSession.swift:361`) fires every 200ms (~5 fps) and dups the last frame — it exists for A/V sync (keep video from falling behind audio during idle), NOT for motion smoothness. It CANNOT be raised toward 30 fps to make the capture itself CFR without first solving the late-frame-PTS race the code already flags at `:54-57`: a real SCK frame arriving with a PTS below a just-emitted heartbeat dup flips AVAssetWriter to `.failed`. At 200ms the race is rare; at 33ms it is constant. A 15fps middle ground was considered and **skipped entirely** — not needed, because the only consumer that plays the raw capture, the review window, applies zoom via a `requestAnimationFrame` CSS transform off `video.currentTime` (`Review.tsx:2337`), fully decoupled from capture fps, so review is already smooth. The CFR fix lives at export; the capture stays sparse-but-correct.

## 2026-07-17 — Backing-scale (2x Retina) capture: SHIPPED steps 1-2; 1080p-supersample is the likely default (owner deciding)

The "why does Screen Studio's zoom look sharper" answer was capture-side: we captured at LOGICAL resolution (SCDisplay.width returns points on macOS 26; the old scale collapsed to 1.0), so every zoom upscaled pixels that were never captured. Greenlit after a spike proved the thermal win survives 4x pixels (4K V3 = 0.092 CPU-s/s vs V2's 1.62 — media-engine-bound, not CPU-bound; cpu/wall drops 0.39->0.22 at 4K). Building gated, in owner's order: (1) capture change, (2) bitrate, (3) zoom thresholds, (4) bubble padding.

**Step 1 SHIPPED (27d0e11): capture at backing resolution.** `CGDisplayCopyDisplayMode(pixelWidth/width)` gives the real per-display 2x; `captureGeometry()` returns width/height/cursor-scale as ONE coupled triple so they can't diverge (the silent "focus drifts top-left" bug). All three branches (display/window/area) through it. GeometryTests (swift test, new target, 4/4). **SCK really delivers backing detail — confirmed, not assumed:** a real 1512x982-logical display captured 3024x1964; the cursor sidecar video_size matched (3024x1964, samples in doubled space = lockstep held in production); and a within-image control showed the native capture differs from its logical band-limit by **11.6 dB more** than an already-band-limited image does (PSNR 31.6 vs 43.2) — an upscale would show ~0 gap. Owner's eye on a dense dashboard: numerals cleaner, dock icons show specular/gradient detail the logical capture averaged flat ("what makes a recording feel cheap without being able to say why").

**Step 2 SHIPPED (this commit): resolution-proportional bitrate.** Flat 8 Mbps starved 4x the pixels (0.045 bpp). Replaced with a constant **0.18 bits/pixel** (the density 8 Mbps already encoded at 1512x982x30 logical) x actual pixels x fps, in BOTH the capture (RecordingSession.swift) and the V3 compositor output (main.swift, keyed off OUTPUT dims). Auto-derives ~32 Mbps at a 3024x1964 capture and ~13 Mbps at a 1920x1246 supersampled 1080p export. On REAL screen content VideoToolbox ABR undershoots hugely (32M target -> ~4.6M actual at 4K, ~3.2M at 1080p), so the higher ceiling costs little on dashboards — it only protects dense content. V2 export paths (edit.rs/composite.rs -b:v 8M) NOT yet updated — V2 is the rarely-hit fallback; a follow-up (composite.rs is in legacy_args_pinned, needs a deliberate re-pin).

**1080p-supersample is likely the new default export (OWNER DECIDING).** Measured on the real 3024x1964 / 25.9s capture (median of 3, identity): 4K export 7.1s wall / 15MB / 35MB-per-min; **1080p-supersample 3.1s wall / ~10MB / ~24MB-per-min — 2.3x cheaper wall than 4K** (encode is the cost; 1080p encode is cheap) and, crucially, **visibly sharper than the logical path** (supersampling real 3024 detail down to 1920 beats upscaling 1512 logical detail — owner-visible on numerals + icons). Rationale: LinkedIn (owner's main destination) caps at 1080p anyway, so capture-at-backing + export-at-1080p is sharper than the old native-logical-1080p AND cheaper than shipping 4K. This is the "capture high, deliver 1080p" supersampling default. Not yet wired as the UI default resolution — owner confirms first.

**Remaining:** owner picks the default export resolution (1080p-SS recommended); step 3 (zoom detection thresholds — absolute-px, halve at 2x telemetry; own gated phase, three pinned fixtures re-judged BY EYE, not just rescaled); step 4 (bubble PADDING_PX absolute -> relative); V2 bitrate follow-up.

## 2026-07-17 — Reclaimed fallbacks 3 (downscale) + 5 (webcam-no-zoom) from V2 into V3 (BUILT)

Two of the v1-switchover fallbacks are now first-class V3 paths. Owner priority: these are the two most likely to be hit while cutting real demos, both low-risk, no new timing gate. Trim (1) stays on V2 (its own phase when/if the toast fires often); GIF (2) stays on V2 (new Swift code, not urgent). Fallback 4 (annotations) stays dead-by-construction; 6 (V3-error safety net) and 7 (multi-segment webcam) stay as fallbacks.

**Fallback 3 — downscale. Was SCOPE, not a technical limit.** The V3 compositor already Lanczos-downscales internally (zoom, watermark, bubble); it just had no output-size knob — output W/H was taken from the source `naturalSize` and hardcoded into the writer/adaptor/render bounds. Fix: `run_v3_export` computes even, aspect-matched output dims (`v3_output_dims`, mirroring V2's `mp4_scale` `-2:480`/`-2:720`/`'min(iw,1920)':-2`) and passes `OUTPUT_WIDTH`/`OUTPUT_HEIGHT`; `main.swift` appends ONE terminal `CILanczosScaleTransform` to those dims AFTER every overlay (exactly where V2's `mp4_scale` sits), then renders to the smaller buffer. Absent env -> output == source, byte-for-byte the old Source path. This is the fix for "720p slower than 1080p": V2's 4x oversample is source-sized, so a smaller output only ADDED a scale stage; V3 renders once at source and downscales once, and full-res 720p→V3 skips the oversample entirely. Verified: 1280x720 → P480 yields 854x480 (== V2's `-2:480`), 709-tagged, audio present.

**Fallback 5 — webcam-no-zoom. Was SCOPE, not a gap (the audio question resolved).** The worry was that V2's no-zoom `composite()` audio `itsoffset` might be a real webcam-sync requirement that V3's no-shift mux would get wrong. It is not: that `itsoffset` only drops the generic SCK mic-init leading gap (`audio_shift` = the screen mp4's audio `start_time`, 0–70ms), which is unrelated to the webcam. Every zoom export already ships via the single-input path WITHOUT that correction and reads as in-sync, so V3's mux matches what's already accepted. The actual webcam A/V sync is on the VIDEO side (`WEBCAM_LEAD_MS`/`tpad` in V2, `BUBBLE_LEAD_FRAMES` in V3, already replicated). The V3 compositor renders empty zoom segments as a static full-frame + bubble (no-op, not a failure). Fix: drop the `has_webcam && !has_zoom` guard in `decide_v3`. Only observable delta vs the old V2 path is ≤70ms of retained mic-init lead — identical to every zoom export.

**Routing note vocabulary shrinks.** `decide_v3` no longer emits the `"<res> downscale"` or `"webcam without zoom"` V2-fallback toasts (both are V3 paths now). Remaining visible fallbacks: `trimmed export`, `sidecar has N annotation(s)`, `webcam has N segments`, `V3 error: <msg>`. `Mp4Resolution::label()` removed (its only caller was the downscale note).

**Verification:** lib suite 45/0. `v3_decision_table` updated (downscale + webcam-no-zoom now assert `run`, deliberate). New `v3_downscale_and_webcam_no_zoom_exports` spawns the real cicompositor for both paths (dims/tag/audio). `legacy_args_pinned` + all byte-pins intact. No new VFR-truncation risk: V3 pulls source frames 1:1 with source PTS (unlike V2's zoompan CFR model — defect #2 above), so downscaled V3 exports don't truncate.

## 2026-07-17 — V2 defect #2: VFR truncation freezes the last ~8s of downscaled/trimmed zoom exports (FIXED)

**V2 export truncation bug (found cutting real videos; second V2 defect after the color-tagging one at 2026-07-16).** A zoomed export routed to V2 — i.e. a downscale (720p/480p) or a trimmed export, since full-res zoom exports go to V3 — froze on the last ~8 seconds: the video stream ended early and the final frame held while audio kept playing. **Root cause:** `zoom_filter_fragment` (`edit.rs`) runs `zoompan`, which has no VFR passthrough and emits at its own `fps=30`, but the screen source is variable-frame-rate (~29fps, SCK caps at 30 via `minimumFrameInterval` and drops frames under load). zoompan's frame-count model assumed 30fps input against a shorter VFR reality, so the re-encoded zoom video came out shorter than the audio track and the tail froze. **Fix:** prepend `fps=30` to the zoom fragment so the VFR source is conformed to CFR30 *before* zoompan (one line at `edit.rs`; mirrors the identical `fps=,scale=` VFR-conform idiom already used by the GIF tail). Single shared call site (`edit.rs:1947`), so the fix covers every V2 zoom export — downscale, trim, and full-res-with-flag-off.

**No deliberate test re-baseline was needed (corrects the going-in assumption).** The fix was expected to trip `legacy_args_pinned`, but that test byte-pins the `composite()` webcam-overlay pipeline (`tpad`/`hflip`/`alphamerge`/`overlay` → `composite.mp4`), which contains no `zoompan` — nothing in the crate byte-pins the zoom fragment string. Full lib suite 44/0 after the fix, `legacy_args_pinned` still green. V3 path never had the bug (it does a 1:1 frame pull, not zoompan). V2 stays as the runtime safety net; this removes a truncation defect from that net.

## 2026-07-17 — Audio NR: macOS Voice Isolation ON + Zeigen RNNoise OFF (owner's setup)

Settled after owner A/B testing. Owner keeps a mechanical keyboard next to the laptop and runs **macOS Mic Mode = Voice Isolation** essentially always. That mode is applied at capture and reaches Zeigen's `AVCaptureSession` mic stream.

**Decision:** for owner's setup, **Voice Isolation ON (macOS) + Zeigen's own noise reduction OFF** (`NrLevel = "off"`, so `settings.rs::noise_reduction_mix` returns None and no `arnndn` pass runs). Do NOT rip out RNNoise — keep it as the off-by-default toggle it already is.

**Why (measured, not assumed):**
- **Don't double-process.** The old default `NrLevel = "med"` meant Voice Isolation ducked the audio in real time, then RNNoise ran again over the hollowed signal — worse artifacts (audible voice clipping on talk-and-type overlap). Turning Zeigen NR off removes the second pass; talk → pause+type → talk now records clean.
- **RNNoise is the wrong tool for keyboard/mouse.** A/B: at Med and High (macOS Standard) typing was clearly audible; High filtered marginally more than Med but nowhere near Voice Isolation, which removed typing AND mouse clicks entirely. Root cause: RNNoise is a **stationary/broadband** model (fan, hiss, hum); impulsive transients (clicks) pass through. Voice Isolation is transient-aware ML source separation. So "crank NR to High" is NOT a keyboard fix.
- **RNNoise's niche for owner is narrow** — quiet-room, no-typing recording with steady hiss. A nicer mic doesn't change this (may pick up MORE keyboard); Voice Isolation stays the transient tool regardless of mic.

**Rejected:** making Voice Isolation the app's suppressor (apps can only READ mic mode, not set it — non-deterministic, hostage to a Control Center toggle) and any "nudge to Standard" prompt (wrong-shaped — owner wants suppression, so it'd nag every time). A future "Auto" mode (read active mic mode, skip RNNoise when Voice Isolation is active) was considered and **parked** — the persistent NR toggle already covers the steady state plus the occasional wildcard flip.

**Residual edge:** exact talk-and-type overlap still ducks the voice slightly under Voice Isolation (real-time gate can't separate a keystroke landing on a syllable). Rare in practice; the one-off escape hatch is Mic Mode → Standard + Zeigen NR → Med for that session.

## 2026-07-16 — Auto-load suggested zooms at review-open: APPROVED + planned (not yet built)

Owner trusts the C.1 zoom detector now (tuned, judged, better than Screen Studio) — the "button-only until it earns it" gate (ZOOM-LAYER-PLAN) is lifted. Auto-populate suggestions on review-open. **Reasoning:** the copy-path concern is solved by making the escape hatch one click — a "Clear all zooms" button. Common case (owner always wants zooms) becomes free; rare case (plain `-c:v copy` export) is one click back. The friction was backwards — owner was clicking Suggest every time for the thing they always want. With V3 default, the zoomed re-encode is cheap, so defaulting to zooms costs little.

**Shape (approved, resume here — NOT built):**
- Auto-load effect: runs ONCE at review-open (ref-guarded mount effect) when `sourcePath` + `duration` ready, sidecar loaded, and `zoomSegments` empty → calls the existing `suggestZooms` (silent on no-telemetry) → folds the result into the loaded `snapshot` baseline + persists immediately.
- "Clear all zooms" button in the Zoom accordion → `setZoomSegments([])` + deselect.
- No Rust changes (`suggest_zooms` command exists; no new sidecar field).

**Q1 — three wrinkles (only one real):**
1. **dirty/"— edited" baseline (real).** Zooms load into `snapshot` (last-saved baseline), then auto-load mutates `zoomSegments` after → `currentState != snapshot` → header shows "— edited" on open before the user touches anything. Fix: fold auto-loaded zooms into `snapshot` so they read as the default; then a Clear correctly shows "— edited". Also persist the auto-zooms immediately (not just via debounce) since the export reads the sidecar.
2. **Async timing.** `suggest_zooms` needs sourcePath + duration + cursor telemetry; lane populates a beat after open; "no telemetry" must be SILENT (no notice spam per open).
3. **Default export re-encodes** (zooms present) instead of `-c:v copy`. Deliberate — Clear-all restores copy; cheap under V3.

**Q3 — once, and structurally can't re-run.** Each recording gets exactly ONE review window (`review-<stamp>`, created at finalize); the app never reopens recordings. So a mount-time auto-load runs once and a Clear stays cleared with NO persisted flag. Code comment added at `suggestZooms`: IF reopening is ever added, a persisted "already-suggested" flag becomes necessary (empty zoom track = absent field / deleted sidecar, so "never suggested" and "cleared" are indistinguishable without it).

**Q2 — accordion shape (RESOLVED).** Slims but stays (the per-zoom Scale slider is the one control not on the timeline lane — its reason to exist). KEEP Scale (when selected), ADD "Clear all zooms", RENAME "Suggest zooms" -> "Re-suggest" (regenerate), **RETIRE "Add zoom at playhead"** (owner, 2026-07-16 — the timeline click-to-add / 2b covers it). Final section = Re-suggest + Clear-all at top, Scale when a zoom is selected.

## 2026-07-16 — Bubble shadow LOCKED: offset-down-right drop shadow (model history + params)

The V3 bubble depth (flagged in the entry below) is shipped. Final model + the dead ends, so nobody re-derives them.

**Shipped model (main.swift `elevated`, now the V3 DEFAULT):** a same-size silhouette, offset DOWN-RIGHT, moderately blurred. Params (fractions of diameter d): **blur 0.04·d, offset 0.05·d down + 0.05·d right, alpha 0.48.** Composited under the opaque bubble so the top-left is fully occluded (no halo) and only the bottom-right escapes → reads as a lit object. Calibrated by pixel measurement to a PowerPoint "offset bottom-right" reference: escape ~0.105×D on right+down, ~0.39 darkening on white, ~0 on left+up. `PADDING_PX` bumped 24→30 (V2 composite.rs + V3 main.swift + preview BUBBLE_ZONE_PADDING_PX, in sync) so the ~25px escape has full room instead of clipping 1px at the corner. Preview box-shadow mirrors it (set imperatively in BubbleLayer's effect so it scales with cssDiameter). Rust `build_v3_bubble_assets` needed NO change — its silhouette is already same-size d.

**Model history — two dead ends (don't repeat):**
- **Enlarged silhouette (silhouette > bubble) = WRONG.** It fixed an earlier washout but rings the object on every side including the top — a halo, no offset read. A silhouette larger than the bubble is not offset-able into a drop shadow.
- **blur > bubble radius = WASHOUT.** A big Gaussian (blur 0.4–0.6·d, i.e. > the 0.5·d radius) spreads the silhouette's mass over a huge area and collapses the peak alpha from ~1.0 to ~0.3 before alpha applies. Result: faint, and levels indistinguishable (measured: "light" +24.7 vs "heavy" +29.8 darkening — same). Proven via a sanity render (alpha 0.9, blur 0.15·d) that darkened +50–72, confirming the pipeline was fine and the blur model was the bug.
- **Why blur 0.04·d is NOT too small (it will look wrong to a reviewer):** it's the CI Gaussian RADIUS on a SAME-SIZE silhouette, under the bubble radius so the peak survives; combined with the 0.05·d offset it produces the measured 0.105×D escape / 0.39 darkening that matches the reference. Bigger blur here re-introduces the washout. Do not "fix" it upward.

**Harness divergence is now REAL and BY DESIGN.** `harness/build_bubble_ab.py` compares V3 vs V2; V3 now ships the offset shadow, V2 keeps its flat gblur shadow, so the bubble + shadow_band region diffs diverge intentionally. This is NOT a regression and NOT a V2-parity gate anymore (re-baselined + noted in the harness header). Mask/placement (mechanical) and screen-anchoring under zoom still hold and stay checked.

## 2026-07-16 — Bubble depth: V3 will DELIBERATELY depart from V2 (harness divergence is BY DESIGN)

Owner, real use: the webcam bubble reads flat / "pasted on top" rather than floating above the screen. NOT a regression — V2 had the same flat treatment; V3 inherited it by faithful port (parity did its job). Current treatment (both preview `boxShadow: 0 8px 24px rgba(0,0,0,0.22)` and export composite.rs gblur σ=0.075·d, offset=d/30, α=0.22): a single tight soft drop shadow, hard circular edge, no rim.

**DECISION: fix it in V3 as a deliberate departure from V2.** Treatment TBD — owner judges by eye (candidate levers: larger/softer ambient shadow + a small tighter contact shadow, more vertical offset, and/or a subtle bright rim on the bubble edge). Not chosen yet.

**HARNESS IMPLICATION (flagged so it doesn't trip later as a mystery regression):** once this lands, `harness/build_bubble_ab.py` + `spatial_diff.py` will show INTENTIONAL divergence from V2 in the `bubble` and `shadow_band` regions. The V2-parity bubble A/B is NO LONGER the gate for the bubble — re-baseline that harness to the chosen V3 look (or retire the V2 comparison for the bubble region). Do not read the divergence as a regression. The bubble's other invariants (screen-anchored under zoom, A/V lead) still hold and stay gated.

## 2026-07-16 — Trim phase SCOPED + PARKED (not greenlit); switchover covers the typical export

**Usage correction (owner).** Earlier concern that trim dominates real exports was based on bad self-reporting — the heavy trimming was TESTING. Real-world trim is an occasional tail-end cut, not every export. So the untrimmed-only v1 switchover DOES cover the typical export (screen + webcam + a couple zooms, untrimmed), and the original default-on recommendation stands. Trim staying on V2 costs little in practice. Owner will rebuild and watch the "rendered via V2 fallback: trimmed export" toast; if it's rare (expected), the trim phase stays parked indefinitely. Greenlight only if that toast turns out to fire often.

**Trim phase scope (for when/if it's ever greenlit — don't re-derive).** V2's trim is entangled with exactly the three things V3 touches, so it is NOT "just an -ss/-to copy pass":
- **Right approach: teach the compositor a trim window (`TRIM_IN`/`TRIM_OUT`).** It reads all frames, emits only those in `[trim_in, trim_out]`, resets output PTS to 0. Keeps it to ONE encode and stays frame-accurate. Zoom can then stay keyed off original PTS (no per-segment shift needed), or shift segments by `-trim_in` if the compositor resets its clock.
- **The trap: a `-c copy` pre-trim pass.** Keyframe-accurate only — the cut can land up to a GOP (~1-2s) off. V2 is frame-accurate because it re-encodes with `-ss/-to` before `-i`. Matching that with a pre-pass would need a re-encode (eats the perf win); the compositor-window approach avoids it.
- **Risk concentrates in (b), the webcam lead × trim.** V2 does NOT trim the webcam at `trim_in`; it trims at `trim_in - 105ms` (`wc_skip = (trim_in - lead).max(0)`, `pad_lead = (lead - trim_in).max(0)` in build_webcam_overlay). So the webcam's trim offset differs from the screen's by the WEBCAM_LEAD_MS. A naive `-ss trim_in` on the webcam desyncs the bubble ~3 frames at the cut. The lead logic shipped in this switchover (`BUBBLE_LEAD_FRAMES`) assumes an UNtrimmed start and would need to fold in the trim offset.
- Other two interactions (lower risk): (a) zoom segments are in original time — V2 shifts by `off=trim_in`; V3 shifts or the compositor honors original PTS. A zoom straddling `trim_in` must render mid-ramp / fully-in at t=0, not restart. (c) audio mux must `-ss/-to` the SCREEN audio to the same window (sample-accurate) and stay locked to the trimmed video.
- Size estimate: comparable to the bubble+lead work in this switchover — compositor change + Rust plumbing + trimmed audio mux, most risk in (b).

**Gate (prove trimmed V3 == trimmed V2):** (1) frame accuracy — trimmed V3 frame 0/last match the source frames at trim_in/trim_out (SSIM/PSNR, and vs V2 frame 0); the thing a copy-trim silently gets wrong. (2) duration within one frame of the window and of V2. (3) bubble A/V sync across the cut — step-function method (as used for the lead) at t=0, for BOTH `trim_in > 105ms` and `trim_in < 105ms`. (4) zoom straddling trim_in renders correct partial scale at t=0 (scale-vs-time curve vs V2). (5) audio lipsync + length. (6) re-run the CPU/wall perf gate ON trimmed content (the trim handling is new cost) — confirm the <=60% win holds.

## 2026-07-16 — V3 switchover LANDED (wired + verified, default-on)

The wiring from the entry below is implemented and committed. V3 is now the default export path for eligible exports; V2 is the visible fallback.

**Shape as built (two corrections to the plan below):**
- Seam is NOT an in-body branch at `edit.rs:867`. `run_edit_pipeline` is a thin wrapper; the entire old body moved VERBATIM to `run_edit_pipeline_v2` (untouched). Wrapper: `decide_v3(use_v3_compositor(), ...)` -> on `Run` try `run_v3_export`, on its `Err` log + fall through to `_v2`; returns `PipelineReport { route_note }`.
- Debug cicompositor path is NOT `compositor-engine/cicompositor` "already committed" — that binary is **gitignored**. `build.rs` swiftc-compiles the compositor to the recording-engine scratch (`target/recording-engine-build/cicompositor`) and stages `binaries/cicompositor-<triple>`; the debug runtime resolves the scratch output (mirrors `engine_binary_path`). Verified V3 still runs with the local gitignored copy moved aside.

**Fallback note is specific (owner requirement).** `SaveResult.route_note` -> Review.tsx toast, "rendered via V2 fallback: <trigger>": `trimmed export` / `<res> downscale` / `sidecar has N annotation(s)` / `webcam has N segments` / `webcam without zoom` / `V3 error: <msg>`. GIF, flag-off, and the plain `-c:v copy` path are deliberately SILENT (self-evident, not fallbacks).

**Fallback #4 (legacy sidecar with annotations) is DEAD BY CONSTRUCTION, not merely rare.** The app does not open existing recordings — the export path only ever runs on a freshly-recorded session, and annotation-writing was removed when Phase 3 was scrapped, so a live sidecar never contains annotations. `sidecar.annotations` is therefore always empty in practice and this branch never fires today. The predicate + code stay as INSURANCE for a future "open existing recording" feature; if that ever lands, this is a live path again. Until then, nobody should treat it as one worth maintaining. (Code comment at the check in `decide_v3` says the same.)

**7th fallback added + owner-approved: multi-segment webcam -> V2.** A Continuity drop spawns `webcam-01.mp4`…; cicompositor takes a single `BUBBLE_WEBCAM`, concat is untested new code, and `segment[0]` would drop footage — so 2+ segments route to V2 (named note). Single-segment (built-in/USB, the Phase-4-gated common case) stays on V3. Conservative reading of "no untested code in the switchover commit."

**Verification (all pass):** unit `v3_decision_table` (flag-off + all 7 fallbacks + exact notes, pure — flag is a param so no settings.json needed); `v3_export_produces_tagged_mp4_with_audio` (real cicompositor + audio mux; asserts 709 transfer tag = the V2-tagging-bug discriminator, source dims, audio present); copy path byte-exact via existing `empty_zoom_stays_on_video_copy_path`; V2 regression tests repointed to `_v2` and green; full lib suite 44/0; `legacy_args_pinned` + mask/shadow byte-pins intact. Bubble lead parity (step-function A/B, webcam flips at frame 10): V2 `tpad=0.105` flips at output frame 13, V3 `BUBBLE_LEAD_FRAMES=3` flips at 13 (exact), V3 lead=0 at 10 (proves the lead is needed). Spatial bubble parity unchanged from Phase 4 (only the temporal pull was touched).

**Turn it off:** settings.json `use_v3_compositor: false` (or the `set_use_v3_compositor` command) — next export runs V2, no rebuild. `git revert` of this commit restores V2-default.

---

## 2026-07-16 — V3 switchover: v1 scope AGREED (option 1) + wiring plan (NOT yet implemented)

All Phase 6 gates passed (entries below) → switch V3 to default. This records the agreed v1 scope and the wiring plan. **The wiring is NOT yet implemented — no code written; investigation was in progress when context was cleared. Resume from here.**

**Escape hatch (owner-approved), three layers:**
1. Runtime flag `use_v3_compositor` in settings.json, default **true**. Flip to false -> next export runs V2, no rebuild.
2. **Automatic fallback, made VISIBLE (owner requirement — not silent):** if V3 fails, log a line AND surface a note in the export result/UI ("rendered via V2 fallback: <reason>"), then run the existing V2 path. A V3 failure costs a slower export, never a lost recording.
3. `git revert` of the single switchover commit restores V2-default.

**v1 routing — V3 engages ONLY for:** untrimmed, mp4, Source-resolution (no downscale), re-encode exports with zoom and/or webcam bubble and/or watermark, and an empty annotations track.
**Falls back to V2 (visibly) for:** trimmed exports; GIF; non-Source resolution downscale (`mp4_scale`); any legacy sidecar with annotations (V3 dropped annotation rendering, V2 still has it); webcam-WITHOUT-zoom (that path is the two-pass `composite()` which needs an audio itsoffset shift — out of v1 scope); and any V3 failure. The plain non-zoomed `-c:v copy` fast path is UNTOUCHED (V3 gated on `!mp4_video_can_copy`).

**Why option 1 (trim -> V2) over option 2 (add a pre-trim pass):** every Phase-6 number and blind judgment covered untrimmed re-encodes with zoom/bubble/watermark — that is exactly what V3 was gated on. A pre-trim pass is untested new code; the owner refused to land it in the same commit that flips the daily-driver default. Trimmed exports staying on V2 cost nothing (same speed as today). If real use shows trim dominates, option 2 becomes its own phase with its own gate.

**Wiring plan (resume here — all file:line from the export-path map):**
- Seam: branch at the top of `run_edit_pipeline` (`edit.rs:867`). Compute `v3_eligible` (predicate above), and if `use_v3_compositor() && v3_eligible`, `match run_v3_export(...) { Ok => return Ok, Err(e) => { log+surface; fall through to existing V2 code } }`. V2 code below stays literally untouched.
- Eligibility inputs: mp4 + Source-res (mirror `mp4_scale` calc, `edit.rs:1200-1220`, must be None), `sidecar.trim` normalized untrimmed (`edit.rs:1227-1234`), `sidecar.annotations.is_empty()`, `has_zoom = !zoom_keyframes_to_segments(&sidecar.zoom).is_empty()`, `has_webcam = !webcam_segments.is_empty()`, watermark present; and NOT(has_webcam && !has_zoom).
- `run_v3_export`: (a) locate `cicompositor` binary — mirror `engine_binary_path()` (`engine.rs:159-175`): release = next to app exe, debug = `compositor-engine/cicompositor` (already built, committed). (b) render bubble mask+shadow PNGs by reusing `composite::build_webcam_overlay` (`composite.rs:636`) or making `render_alpha_mask`/`render_shadow_source` (`composite.rs:437,463`) `pub(crate)`. (c) convert `sidecar.zoom` (ZoomKeyframe, center in source px) -> cicompositor `ZOOM_SEGMENTS` JSON `{start,end,scale,ramp,cxf,cyf}` where cxf=center_x/W, cyf=center_y/H (center fractions, top-origin), ramp=`ZOOM_RENDER_RAMP_S`=0.6. (d) spawn `cicompositor <screen> <video_only.mp4> identity` with env ZOOM_SEGMENTS, BUBBLE_WEBCAM/MASK_PNG/SHADOW_PNG/DIAMETER/ZONE/SHADOW_ALPHA, WATERMARK_PNG/CORNER/SCALE_FRAC/OPACITY, and **BUBBLE_LEAD_FRAMES** (see next). Check `status.success()` + output non-empty. (e) mux audio: `ffmpeg -i video_only.mp4 -i <screen> -map 0:v -map 1:a? -c:v copy <arnndn -af> -c:a aac -b:a 192k -movflags +faststart <output>` — audio is the SCREEN source's, arnndn via `audio_nr_filter()`, NO itsoffset (single-input path doesn't shift).
- **Webcam A/V lead (MUST add to `main.swift` + verify):** V2 freezes the first webcam frame for `WEBCAM_LEAD_MS = 105ms` (`composite.rs:76`, `tpad=start_duration=0.105:start_mode=clone`) so the bubble is in sync from t=0. cicompositor does a naive 1:1 pull — add `BUBBLE_LEAD_FRAMES` env = round(0.105*fps) (~3 at 30fps): for screen frames `i` where `i==0 || i>leadFrames` pull the next webcam frame, else reuse frame 0 (i.e. show webcam frame `max(0,i-lead)`). **Verify bubble sync parity vs V2 on the harness before committing.**
- Bundling: mirror `recording-engine` sidecar — `build.rs` compiles the compositor to `binaries/cicompositor-<triple>`, add `"binaries/cicompositor"` to `externalBin` in `tauri.conf.json`.
- Settings: add `use_v3_compositor: bool` (`#[serde(default=default_true)]`, Default true) to `Settings` (`settings.rs:11`), a free-fn `use_v3_compositor()` mirroring `noise_reduction_mix()` (`settings.rs:98`), and a `set_use_v3_compositor` command registered in `lib.rs:826`.
- **Verify all THREE directions before the single commit:** (1) real re-encode export runs V3 with flag on, (2) flag off routes V2, (3) plain non-zoomed `-c:v copy` untouched. Plus harness parity of the V3 export vs V2 (bubble sync + overlays within floors). No real scratch recording exists to test against (they're transient) — construct a synthetic recording (sources/ dir with screen.mp4 + webcam-00.mp4 + a sidecar JSON with zoom/bubble/watermark) and run the actual Rust pipeline functions on it.

## 2026-07-16 — Phase 6 ALL GATES PASS → switch V3 to default

Sustained thermal run (205s non-repeating clip, 36 varied zooms + bubble + watermark, 3 reps), owner-measured:
- **V2: ~90s wall, ~355s CPU, 366MB** (consistent across 3 reps).
- **V3: ~23s wall, ~18s CPU, 56MB** (consistent across 3 reps).
- V3 = **~5% of V2 CPU, 3.9x faster wall, 6.5x less memory.**

**Caveat (owner, important): the sustained thermal test ran on the MacBook Pro, NOT the fanless Air.** The Pro has fans (V2 barely audible, V3 quieter), so fan/throttle behavior on the *target* fanless machine is technically UNTESTED. The ~20x CPU delta makes the thermal claim near-certain, but if a fanless-Air throttle issue ever appears, this is the untested assumption to revisit.

**Gate verdict (owner): ALL PASS** — CPU (5% << 60%), wall-time (26% << 60%), tripwires green, quality (V3 visibly cleaner on edges), thermal (near-certain via CPU delta, Pro-not-Air caveat noted). → Wire V3 into the Rust export path behind a runtime flag and flip the default to V3. V2 path stays intact as the escape hatch.

## 2026-07-16 — Phase 6 standalone gate PASS; found a V2 export tagging bug

Standalone perf gate (21.4s 1080p dashboard, 3 zooms + bubble + watermark), median of 3:
- **CPU-time V3 = 4.3% of V2** (1.50s vs 34.73s) — clears the <=60% bar hugely (the thermal thesis on paper).
- **Wall-time V3 = 31.9% of V2** (2.55s vs 7.99s) — clears the <=60% bar (3.1x faster).
- Tripwires green: frame count matches; V3 atoms 709/tv/yuv420p complete; bubble box dE 0.60, watermark dE 0.41 (within floors); zoom-peak SSIM ~0.98.
- Quality (owner eye): V3 visibly cleaner on edges (KPI glyphs, chart diagonals, table text) — the ringing/lanczos win, real and tag-independent.

**V2 export tagging bug (found via the quality A/B — worth knowing even as we move off V2).** Owner saw V2 as washed-out / lifted-blacks vs V3. Measured: it is NOT a pixel difference — stored dark-region Y is identical (30.00 both; full-frame 39.5 both). It is **tagging**: V2's H.264 output drops `color_primaries` and `color_transfer` (writes only matrix=bt709), so a player that guesses the transfer displays it wrong. **All three real `~/Movies/Zeigen` exports checked have the same `transfer=unknown, primaries=unknown`** — so V2 has been shipping mis-tagged files, not just the harness. V3 tags all three correctly. Re-tagging V2 with `h264_metadata` bsf (VUI rewrite, no re-encode, pixels unchanged) restores correct interpretation. Fixing V2's tag-writing is a separate V2 concern; V3 does not have the bug.

**Remaining before switchover:** owner re-confirms quality on the re-tagged apples-to-apples pair (edge win is tag-independent so it should hold), then the Air thermal test (kit built: `~/Desktop/zeigen-thermal-kit/`). Only if both pass: wire V3 into the Rust export path behind the flag + flip. Nothing wired or flipped yet.

## 2026-07-16 — Phase 6 perf gate: AGREED BARS (locked with owner before running)

The gate V3 must clear to switch over. All hard unless noted. Scope: re-encode exports only (zoom/overlay recordings); plain non-zoomed saves keep V2's `-c:v copy` fast path and are out of scope.

1. **CPU / thermal proxy (hard):** V3 video-stage CPU-time (user+sys, `/usr/bin/time -l`) **≤ 60% of V2's**. This is the real reason to switch (V2's 4x lanczos oversample is CPU-heavy; V3 is GPU + VideoToolbox).
2. **Wall-time (hard, with a judgment band):** V3 video-stage wall-time **≤ 60% of V2 = pass**. **60–100% = report, owner judges** whether the CPU win carries it (NOT an automatic fail). **≥ 100% = fail.** 0.98x does NOT count as a pass — a rewrite that isn't materially faster on zoomed content is a CPU-only rewrite, which is not the claim.
3. **Air thermal test (hard, OWNER-RUN, not optional — it is the point):** owner exports a LONG recording on the fanless Air with V3 (and V2 for comparison) and reports fan spin-up / throttle. If V3 spins the fans the way V2 does today, the CPU-time number didn't buy what it claimed. **Sequenced AFTER the standalone numbers look good**, so it's only spent on something already promising on paper.
4. **Quality (hard, owner eye):** blind real-export A/B, **V3 ≥ V2**, no visible regression (cleaner zoom edges expected).
5. **Correctness tripwires (hard, mechanical — all must pass):** color atoms 709/tv/yuv420p; bubble+watermark bboxes within floors (dE ~1.1 / 0.55); zoom trajectory aligned; frame count matches; audio present + synced.

**Sequence:** standalone measurement (1, 2, 5) + quality A/B (4) FIRST → owner judges → Air thermal (3) → only if ALL pass, wire V3 into the Rust export path behind the flag and flip the default in one commit. **Do NOT wire or flip before the owner has seen the numbers and judged quality.**

**Test recording:** CONSTRUCTED fresh (not one of the owner's old recordings — owner wants to know exactly what's in it), shown to owner for approval BEFORE building: screen + webcam, a couple of zooms, bubble + watermark on.

## 2026-07-16 — Phase 4 DONE (webcam bubble + watermark). Next = Phase 6 (perf gate + switchover)

Both screen-anchored overlays ported to V3 and owner-judged **pass** (blind A/B, indistinguishable from V2). Watermark dE 0.55; bubble dE 1.09 after a color fix (below). Both hold screen-anchored under 2x zoom. V3 still standalone; V2 remains the default export path until the Phase 6 switchover.

**Bubble color root cause (fixed).** First bubble A/B showed a bad gap (box dE 3.67), green-dominant (interior green |d| 18.9 vs R/B ~3), spatial, not sharpness. Cause: decoding the webcam stream to **BGRA** made AVAssetReader guess the YUV->RGB matrix, landing hardest on green (green depends most on both chroma channels) — the same class as the Phase 1 BGRA luma shift. Fix: decode the webcam to native **709 YCbCr** like the screen path, so CI reads color from the buffer's attachments. Dropped to dE 1.09, green |d| 0.66. Residual ~1.1 is benign composite-math (mask edge CIBlendWithMask-vs-alphamerge, shadow CIGaussianBlur-vs-gblur, CI-vs-ffmpeg webcam scaler), sub-visible.

**Deferred, by owner decision (do NOT chase):**
- **Shadow blur radius: left UNTUNED.** CIGaussianBlur radius = 3x gblur sigma (default), shadow-band dE 0.97, owner saw no difference. Tuning buys nothing perceptible.
- **WEBCAM_LEAD_MS: known GAP, not handled.** The compositor pulls 1 webcam frame per screen frame, assuming equal fps (true for our captures). It does NOT apply composite.rs's A/V lead offset, and would drift if webcam fps ever differs from the screen. Logged in `main.swift` at the webcam reader so it surfaces the moment fps differs; irrelevant until then.
- **Trim keyboard asymmetry: intentional.** I/O set the trim points; the Trim accordion section opens by click only (no shortcut opens it, unlike M->Export). Owner: leave it — the real trim feedback is on the timeline, so a section-opening shortcut adds nothing. Do not wire I/O to openSection.

## 2026-07-16 — Phase 4 watermark: PASS

Screen-anchored watermark ported to V3 (`main.swift`, env-driven, mirrors composite.rs). A/B against V2 (same logo PNG, ffmpeg composite.rs fragment replicated): watermark-box dE 0.55 identity, 0.56 under 2x zoom (holds screen-anchored, does not zoom). Owner judged **pass**; A/B clips indistinguishable in motion, logo held still on both.

**Fill-noise note (not pursued — sub-visible).** Owner's eye flagged V3 (blind B) as marginally noisier in the blue *fill* (not edges) at 3x on a still. Measured: total variance identical between V2 and V3; the "solid" patch was actually the logo's gradient, which swamped a clean noise read. A quick check found VideoToolbox deterministic (identical input encoded twice = 0.00 delta), so the ~0.9/255 fill delta is a real render-path difference (CI vs ffmpeg lanczos + color conversion of a saturated-blue gradient), NOT encoder randomness — but it is sub-visible at real viewing conditions and A/B were identical in motion. Not worth chasing. That's the record.

## 2026-07-16 — Our motion blur vs Screen Studio's are NOT comparable (different effect, not a stronger one)

Clarifies the 2026-07-15 motion-blur finding — does not change it. **Do not read "Screen Studio's blur is subtler even at 100%" as evidence ours is too strong.** They are different effects and are not comparable at any strength setting:

- **Ours** is a **radial `CIZoomBlur`** centered on the zoom focus, driven by the scale-ramp velocity of a **hard 0.6s ramp to 2x** — content smears radially outward from the focus, spiking during the ramp and going to zero at the hold. Peak velocity on the demo punch was ~246 px/frame; the demo presets hit their caps (strong/medium/subtle = 95/48/22 px; the sub-subtle blind ladder = half/quarter/eighth ≈ 11/5.5/2.75 px).
- **Screen Studio's** slider is a **directional** motion blur on its **slow eased camera moves** — a linear smear along the movement direction, over longer/lower-velocity motion. A gentler blur type on gentler motion.

So SS looking subtler even maxed is a function of (a) directional vs radial and (b) slow-ease vs hard-0.6s-ramp, NOT of our intensity knob being turned up. Any future "match Screen Studio's blur feel" work must first change the *effect* (effect type + the motion it rides), not just lower our strength. The 2026-07-15 conclusion stands unchanged: our blur is imperceptible at eighth on a 0.6s/2x ramp, out of the value case, kept off-by-default as insurance for faster/bigger zooms only.

## 2026-07-16 — Annotations SCRAPPED entirely (code + UI) — scope cut, not a parity failure

Supersedes "Phase 3 (overlays) next" from the 2026-07-15 entry below. **Decision (owner): drop Text, Arrow, Blur, and Spotlight annotations completely — from the V3 compositor AND the review UI.** This is a deliberate scope cut, NOT a parity problem. In fact text/arrow reached clean parity before the cut (see the root cause below), and blur/spotlight were coded but never exercised.

**Reasoning (owner):** doesn't use Text or Arrow; won't use Blur-as-annotation given how much zooming there is; Screen Studio ships no annotations and doesn't need them. Not porting features to V3 that exist only because V2 had them, and not leaving half-kept features rotting behind a flag.

**What was removed.**
- V3 compositor (`src-tauri/compositor-engine/main.swift`): the overlay compositing path, the `OVERLAYS` JSON plumbing, `pngCache`, the overlay-blur/spotlight rendering, and the overlay-sigma constants. Reverted to zoom-on-`src`. It reads as if overlays were never ported. **Phase 5 radial motion blur (`CIZoomBlur`) stays** — untouched, still off-by-default insurance.
- Harness: `build_overlay_ab.py` deleted.
- Review UI (`src/Review.tsx`, `src/components/SegmentTrack.tsx`): the entire ANNOTATE section, the four tools, the annotation color swatches + helpers, the `Tool` state machine, stage placement handlers, live-preview rendering, and annotation pips — ~1650 lines. The sidecar stops writing `annotations`/`annotation_color` (Rust struct has `#[serde(default)]` on both, so omitting them deserializes cleanly — no Rust change). **Trim and Thumbnail survive** (they were never annotations): Trim is now its own top-level accordion section above Bubble; Thumbnail moved into Export (the poster is an output concern). M (thumbnail) and I/O (trim) shortcuts intact.

**V2 is untouched.** The `edit.rs` ffmpeg overlay path (`rasterize_text`, `rasterize_arrow`, `blur_region_fragment`, `spotlight_region_fragment`) is left in place per the "don't touch V2" scope — it is now dead (the UI never writes annotations) but not removed. V2 remains the default export path.

**Root cause worth keeping (it'll matter for anything composited later).** Text/arrow parity first tripped the harness: overlay-box dE 2.4, PSNR 25.9 dB despite feeding the *identical* PNG to both renderers. Not color/blend — the pill interior fill matched. It was **sub-pixel placement**: V3 composited the PNG at a fractional CI offset (e.g. 0.18·1080 = 194.4), and Core Image interpolated, softening every edge; ffmpeg's `overlay` snaps to integer pixels. **Rounding the CI placement to integer pixels fixed it** (box PSNR 25.9→38.3 dB, residual dE 1.6 sub-JND edge-blend only). Lesson for any future CI compositing of pixel-art/PNG/text layers: **snap placement to integer pixels unless you want sub-pixel interpolation.**

## 2026-07-15 — V3 thesis CORRECTED: perf/thermal rewrite, not a buttery-zoom upgrade

Built and owner-judged V3 Phases 0-2 + 5 (`docs/v3-ci-compositor/`, `src-tauri/compositor-engine/`). Two findings settle the zoom-quality question; do not re-litigate them.

**(1) Ringing win (real, modest).** Static-zoom sharpness is at PARITY with V2 (Laplacian equal across V3, V2, ideal single-lanczos). But Laplacian can't separate ringing from sharpness (ringing adds edge energy). Measuring over/undershoot at hard edges (`harness/ringing.py`): V2 rings **7% more at step>40, 13% at step>70, 14% at step>100**, with ~36% more ringing-spike "edges". V3 rings less than even the ideal ffmpeg single-lanczos — CI's lanczos kernel has **gentler negative lobes**. Same sharpness, cleaner edges. This is the win the Phase-2 parity metric hid; it flips Phase 2 from "pure parity" to "parity on sharpness, cleaner on ringing".

**(2) Motion blur does NOTHING perceptible at 0.6s/2x (blind test).** The "V3 zoom looks better" case had narrowed to motion blur. A blinded ladder below "subtle" (half/quarter/eighth + two no-blur, shuffled, key withheld) was owner-judged. Corrected reading (owner, post-reveal): **at "eighth" strength blur is IMPERCEPTIBLE — the eighth-blur clip and a no-blur clip felt identical.** The owner's earlier "one no-blur clip had a little more blur" was an attention artifact (looking at a different part of the screen), not perception. Only the *perceptible* strengths (quarter, half) registered, and those were rejected as visible blur. So the finding is "**blur does nothing at these speeds**," NOT "owner preferred no-blur over the lightest blur." At a 0.6s ramp to 2x there is no strobe worth fixing, and **there is no point tuning below eighth — that is below the owner's discrimination threshold.** Motion blur is OUT of the value case; code stays (`main.swift`, `BLUR=on`, radial CIZoomBlur, `radius = floor + k*|v|`) as **off-by-default insurance** for faster/bigger zooms only.

**Corrected thesis (inherit this).** V3 is a **performance/thermal rewrite** (encoder-bound, hardware-uniform, no fanless-Air throttle) that also gives cleaner hard edges and untouched non-zoomed frames (V2's whole-timeline oversample softens non-zoomed frames to ~43 dB; V3 leaves them identity at ~53 dB). It is **NOT** the "buttery/expensive zoom" upgrade it was framed as. Also settled this session: Phase 1 color round-trip needs CI color management OFF (`workingColorSpace = NSNull`) — CI's managed 709 round-trip lifts luma ~2.75 levels.

**DECIDED (owner): continue V3, Phase 3 (overlays) next.** The case as it stands justifies finishing: looks a bit better (the ringing win = the "less jaggy" the owner saw), zoom is slightly smoother though not worlds apart, and exports faster. Not a zoom-glamour upgrade, but a real win worth completing. V3 still not wired into the app; V2 remains the default until the eventual switchover.

## 2026-07-15 — Cursor-follow zoom: our travel-detection beats follow-the-cursor (positive reason, not null)

Owner watched Screen Studio: it keeps the mouse loosely in frame while zoomed. Ours instead zooms OUT when the cursor travels a distance and back IN on arrival. **Owner PREFERS ours** — following the cursor across a screen at 2x would be a nauseating pan. So the **follow-the-cursor / center-easing hybrid stays parked for a POSITIVE reason** (our travel-detection zoom-out/in is deliberate and better), superseding the earlier "parked as a null result / zero requests for center-tracking" framing (2026-07-13 entry below). Do not revisit follow-the-cursor as an improvement; it is a known-worse design for this use case.

## 2026-07-15 — V2 core COMPLETE (zoom reaches exports); per-zoomed-span oversample SKIPPED; V3 is next

Step 3 landed (commit `f728fa2`): zooms render into exported mp4s. Two increments — screen-only + preview parity fix, then the webcam seam. As-built notes worth keeping: (1) the zoom render uses **ffmpeg `zoompan` driven by `it` (input time), not `crop`** — ffmpeg 8.1 `crop` has no `eval` and can't vary crop *size* per frame; zoompan is PTS-accurate on the VFR screen source (crop math validated **PSNR 50 dB** vs a reference center-crop). (2) The **preview was the bug**, not the reference: content-anchored annotations now zoom WITH content (`AnnotationLayer` nested in the zoom transform; `BubbleLayer` stays a sibling). (3) The webcam seam **extracted composite's webcam-overlay filter into a shared helper** and refactored `composite()` onto it — `legacy_args_pinned` byte-identity holds, so webcam+zoom reuses the exact proven bubble prep; webcam+zoom routes to a single merged pass (annotations → zoom → bubble → watermark). Owner-verified end-to-end on a real 6-min / 30-zoom recording incl. front+end trims: zoom matches preview, A/V in sync, softening below perception. Now the owner's **daily driver**.

**Per-zoomed-span oversample: SKIPPED (owner).** The whole timeline is oversampled whenever any zoom is present, so non-zoomed spans are re-encoded (roundtrip softens ~40.7 dB PSNR / 0.995 SSIM — slight, below perception in motion, but real) and the recording pays the 4x cost end-to-end (~2.5 min for 6 min / 30 zooms). Per-span oversample would fix cost + softening and keep non-zoomed spans on `-c:v copy`, but **V2 is a temporary daily driver and the owner is spending the next cycles on V3, not on optimizing V2.** Accepted as-is. (`3x oversample` — a single `ZOOM_OVERSAMPLE` constant — remains a validated-later A/B if V2 ever needs it.) UNTESTED combo left as-is: watermark + webcam + zoom together.

**Next effort: V3** (Core Image / Metal compositor) — see the 2026-07-14 entry below and `docs/v3-ci-compositor/`. V3's bar stands: must NOT regress V2 on performance OR quality (full-pipeline, not isolated zoom; GPU output quality must be tuned — spike was ~8-11 Mbps bilinear vs V2's shipping 8M ABR + lanczos (the earlier "24 Mbps" was a no-`-b:v` scratch test, not the export path — `edit.rs:1654`)); the owner's real V2 exports are now the A/B reference.

## 2026-07-15 — V2 prerequisite: five stream-md5 guards restored (synthesize + un-ignore); a rotted assertion surfaced

Restored the five `#[ignore]`d guards whose May baseline recordings are gone. They're relational/structural (copy holds / arnndn ran / dims / audio<video / sprite grid), not golden-output pins, so they never needed the exact May files — just a conforming input. Rewrote each to **synthesize its own source** (a shared `synth_source` helper: lavfi testsrc2 video + sine AAC, audio optionally shorter than video) and **un-ignored four** (`probe_audio_track_baseline`, `render_preview_audio_baseline`, `mp4_save_baseline`, `sprite_smoke`) so they run in the default suite (35 → 39 passed). `save_recording_baseline` stays `#[ignore]` (runnable on demand) because `save_recording_impl` hardcodes `~/Movies/Zeigen` output — un-ignoring would write test artifacts into the real Movies folder each run; an output-dir refactor is a someday cleanup, not prerequisite scope.

Explicit: these pin **today's** behavior, not the original May safety net (unrecoverable). Their job is forward regression-catching — does adding zoom break plain (non-zoomed) exports — which the four un-ignored ones now do automatically.

**Proof that ignored guards rot silently.** Re-running `save_recording_baseline` after years dormant surfaced a stale assertion: it checked the noop `-c:v copy` via `stream_md5(out, "0:v")`, but `save_recording_impl` runs `try_embed_poster`, which appends a poster as an `attached_pic` **video** stream — so `"0:v"` hashed the poster too and the copy check failed. The assertion predated the poster feature and **would have failed on current code even with the real fixture**; it was just never re-run (ignored + fixture gone). Fixed to `"0:v:0"` (the h264 stream `-c:v copy` keeps bit-exact). Lesson banked: a guard that can't run isn't a guard, and un-ignoring is how you find that out.

## 2026-07-14 — Zoom export split into V2 (ffmpeg now) + V3 (CI compositor branch); supersedes "Swift ruled out"

After the ffmpeg gate was resolved (entry below), a hardware-variance question reopened it and a GPU spike changed the shape. **Decision: finish V2 on ffmpeg (owner's daily driver for weeks), then branch for a Swift/Core-Image V3.** This supersedes the "Swift compositor is OFF the table" line in the entry below — Swift/CI is not off the table, it is V3.

**Why the split (measured, owner's M5).** ffmpeg 4x oversample is **~100% CPU/bandwidth-bound** — filter-only 79.3s ≈ with-encode 78.7s, so the hardware encoder is NOT the bottleneck at 4x. That degrades worst on M1/older-Intel and could thermal-throttle a fanless Air on battery. A throwaway GPU spike (`gpuzoom.swift`, preserved in `docs/v3-ci-compositor/`) rendered the same zooms via Core Image (Metal, sub-pixel, no oversample) and measured decisively better: **~33s vs 79s** for a 5-min export; **encoder-bound at CPU/wall 0.6 vs ffmpeg's 3.6**; **zoom essentially free** (GPU identity re-encode 34s ≈ GPU zoom 33s); peak RSS 113 vs 223 MB. The media engine varies far less across Macs than CPU+bandwidth, so V3 is fast, smooth, AND hardware-uniform.

**V2 ships with the known CPU tax anyway** because the sole user is on an M5 and needs a working recorder now. V2 is a proper daily driver, not a throwaway stepping stone — bugs hit while cutting real demos get fixed in V2, not deferred to the rewrite.

**V2 scope (ffmpeg, ~2 sessions / 2-4 rounds):** (1) prerequisites — guard restoration + flip the non-empty-zoom tripwire to assert re-encode; (2) **zone-based bubble** — constant export position picked in Review, live bubble stays draggable during recording (ephemeral), `bubble_position_log` becomes preview/legacy data export ignores, old recordings default to nearest corner of the log centroid; (3) zoom export — reuse `single_input`'s annotation+trim graph, insert oversample+zoompan, append constant webcam overlay + watermark AFTER the zoom, shift zoom keyframe times by −trim.in, 4x default (3x = validated-later optimization).

**Guard-restoration caveat (owner-acknowledged):** the May baseline recordings are gone (not in git, no LFS, disk dirs absent). "Restoring" the five stream-md5 guards means re-pinning against TODAY's output/a current source — enough to catch whether zoom breaks plain exports, but **explicitly NOT the original May safety net**. (The guards are relational/structural — copy-path holds, arnndn ran, dims, audio<video — not golden-output pins, so re-pointing keeps most regression value; the lost piece is the exact May reference.)

**Zone-based bubble simplifies BOTH paths** and carries forward to V3 unchanged (constant CI layer, no position animation to port). It's a real product improvement independent of render path — solves "the bubble is covering something" by letting the owner pick the least-bad constant zone post-hoc.

**V3's bar — must NOT regress V2 on performance OR quality:** (a) beat V2 measured on the FULL pipeline (zoom + bubble + annotations + blur/spotlight + watermark), not isolated zoom — the 33-vs-79 win was zoom-only; (b) tune the GPU output quality (spike was ~8-11 Mbps bilinear vs V2's shipping 8M ABR + lanczos (the earlier "24 Mbps" was a no-`-b:v` scratch test, not the export path — `edit.rs:1654`) — tunable, must actually be tuned); (c) once V2 is daily-driven, the owner's real exports become the A/B reference and the gate. See `docs/v3-ci-compositor/README.md`.

## 2026-07-14 — Step 4 design gate resolved: ffmpeg zoompan + 4x oversample (Swift ruled out), measured

Spiked the deferred Swift-vs-ffmpeg export-rendering decision risky-measurement-first (like B0), on the real 2026-07-14-201245 recording (1080p). Throwaway spike — scratchpad only, nothing in the tree, prerequisites and real export path untouched. `docs/ZOOM-EXPORT-STEP4.md` updated to RESOLVED.

**Chain of evidence.** (1) Naive `zoompan` truncates crop x/y to integer pixels and **visibly stutters** on a slow pan (owner-judged on a deliberately-slow 2.5s ramp against dense right-edge fine text). Rejected — bar is buttery. (2) The fix is **oversampling** (pre-scale Nx lanczos → zoompan on the upscaled frame → downscale), which makes integer offsets 1/N source px. Mandatory, not optional. (3) Owner judged the oversample ladder on both the stress ramp and the real 600ms default (`ZOOM_RAMP_S`), isolated and as a 3-zoom sequence: naive ✗, 2x slightly stuttery ✗, 3x slightly stuttery on the stress ramp (looked good at 600ms but not committed on 15s of synthetic), **4x buttery everywhere ✓**.

**Decision: ffmpeg `zoompan` + 4x oversample is the committed default; Swift compositor is off the table for smoothness.** 3x is a **validated-later optimization** (single-constant change; A/B on real exports once they exist — halves the tax if it holds), not a blocker.

**Measured cost ladder** (300s / 1080p / `h264_videotoolbox`, whole-timeline oversampled = ceiling):

| Path | Wall (5 min) | vs baseline | Peak RSS |
|---|---|---|---|
| Baseline re-encode | 34.5s | 1.0x | 188 MB |
| 2x oversample | 33.9s | 1.0x (free) | 209 MB |
| 3x oversample | 44.3s | 1.3x | 188 MB |
| 4x oversample | 78.7s | 2.3x | 223 MB |

No memory/thermal blowup at the 7680x4320 intermediate (peak RSS flat; `pmset -g therm` clean). 2x is free (videotoolbox encode is the bottleneck, the 2x CPU scale hides under it); 4x is where CPU lanczos on 8K frames dominates. Baseline 34.5s validates the prior ~29s estimate. Only zoomed recordings pay this, and only zoomed spans need oversampling, so real exports run under the ceiling.

**Still open (not this spike):** overlay ordering — content-anchored (arrows/blur/spotlight) must zoom with content, screen-anchored (webcam/watermark) must not. A Step 4 build question, no longer bearing on Swift-vs-ffmpeg. **Next:** the two prerequisites (restore the five stream-md5 guards; flip the non-empty-zoom tripwire to assert re-encode) before real render work.

## 2026-07-14 — Thread B closed: Slices 2 + 3 dropped as unnecessary (supersedes the earlier same-day entry)

Owner call after judging Slice 1.5: **Thread B is done and closed at Slice 1 + Slice 1.5.** Slices 2 (box-resize handles) and 3 (edit-time zoom preview) are dropped, not deferred. The earlier 2026-07-14 entry below said Slice 2 "still stands on its own" — this supersedes that.

**Both remaining slices had one root cause, and Slice 1.5 solved it.** The real pain was never the Scale slider or the crop box — it was **editing blind** (adjusting size/framing without seeing the zoomed result). Once the loop preview lets you watch the effect while dragging the Scale slider, the slider is fine, so Slice 2's "leave the video to drag a slider" complaint (3a) evaporates. Slice 3 was already flagged redundant here for the same reason (the loop time-multiplexes its crop-box-vs-zoomed-result design question). Two complaints, one cause, one fix. `docs/ZOOM-MANUAL-EDITING-PLAN.md` updated to closed.

## 2026-07-14 — Zoom manual-editing WYSIWYG: Slices 1 + 1.5 shipped; Slice 1.5 collapses Slice 3 (Thread B, judged & committed)

Built and owner-judged the first two slices of Thread B (`docs/ZOOM-MANUAL-EDITING-PLAN.md`), the hand-editing complement to Thread A's conservative detector. Frontend only — no backend/pipeline/schema/export change, byte-identity invariant untouched. tsc clean, cargo 35/35 for both.

**Slice 1 — timeline frame-feedback + ramp shading (`9ff7aea`).** `SegmentTrack` gained two optional props (annotations pass neither, unchanged): `onDragHover`, which the zoom lane wires into the existing `ScrubPreview` so dragging the pip previews the start frame and dragging an edge previews that edge's frame, live above the timeline (reuses `extract_thumb_sprite`, no new extraction); and `ramp`, which paints a brighter held-at-full-scale core (`dur - 2*ramp`) against dimmer ramp shoulders and shows a live `dur . full` readout on the selected band. Kills "editing blind" — the blind START and guessy DURATION complaints — and makes the otherwise-invisible ramp reality (`full` collapses to 0 under 2*ramp) visible.

**Slice 1.5 — looped slow preview + in-loop speed toggle (`8854413`).** Select a zoom, press Space -> a looped half-speed preview of just that zoom (`start-0.5s` .. `end+1.0s`) plays until stopped, so the 600ms ramps read as judgeable motion. `</>` toggle 0.5x<->1x live during the loop (judge slow, confirm at real speed), constrained to `{0.5,1}` because the global `1/1.5/2` cycle omits 0.5x and can't return to it; mid-loop speed changes never leak into the stashed global rate, restored on stop. Every exit (Space, Escape, transport button, deselect) funnels through the video's own `pause` event -> one teardown. Loop window clamped inside the trim range so its wrap never fights the trim-out wrap.

**Slice 1.5 time-multiplexes Slice 3's hard problem — reassess before building Slice 3.** Slice 3 ("edit-time zoom preview") was scoped as a design call: how to show the crop box AND the zoomed result at once. Slice 1.5 answers it by time-multiplexing instead of splitting the view — paused/selected = identity + crop box (the edit view), playing the loop = un-suppressed zoom transform + crop box hidden (the watch view). You never need both simultaneously, so the split-view design question evaporates and the useful half of Slice 3 is already delivered. Mechanically: the live transform's suppression gate flipped from `zoomEditing` to `zoomEditing && !zoom.looping`, and `ZoomEditLayer` now hides while looping. **The remaining Slice 3 work may be unnecessary; reassess whether anything is still wanted before building it.** Slice 2 (box-resize handles) is untouched and still stands on its own.

## 2026-07-14 — Zoom detection reshaped: conservative triggers + post-click-stillness veto (Thread A, judged & committed)

Reworked the step-5 detector from the committed baseline (`943c239`, plain dwell/click heuristic) into a conservative, intent-aware detector. Judged on fresh playback, committed as `7e9e87c`. An uncommitted pre-restart gesture-framing refactor was reset back to the clean base and its proven parts ported forward verbatim; the one unstable knob (merge aggressiveness) was dropped and redesigned rather than tuned on an unstable base.

**Trigger policy — clicks never trigger, they corroborate.** Only the three self-intending signals start a zoom: right-click menus, drags, dwells. A bare click no longer spawns a candidate; it only shapes the dwell it sits in (center + window). A click stop where the user then reads still zooms via that dwell; a drive-by click with no dwell/gesture proposes nothing. This drops the cross-filter-ambiguous bare-click cases by design — added back by hand in the review lane (this is why good manual editing, Thread B, is the complement).

**Rule 1 — post-click-stillness veto (the intent inversion).** What the cursor does AFTER a click reveals intent the click alone can't. If the cursor goes STILL after a click (the whole post-click stretch stays inside `POST_CLICK_STILL_PX` for at least `POST_CLICK_WATCH_S`), the user is watching a consequence that rendered elsewhere (a popup, a new window, a map animating) — attention moved to the screen, not the cursor — so that dwell is vetoed to wide. This inverts the naive "settled = attention" read that was the root of the two real failure cases (an animating map; a window that opened). Local follow-through motion after a click (menu items, nudging in place) holds (rule 2). A CLICKLESS dwell (arrived and settled = reading in place) is untouched and still zooms. "Far travel after a click" (rule 3) needed no new code — the conservative structure already yields nothing there.

**Merge policy designed fresh (not ported).** Two confident candidates bridge only when genuinely co-located: centers within `CENTER_MERGE_PX` AND the union frames at `>= MERGE_MIN_SCALE` (not merely above the gesture floor) AND within `BRIDGE_GAP_S` in evidence time. Far-apart back-to-back gestures stay separate — the corner-to-corner over-merge canary (fixture #2, 153.68–161.81, drag+drag) is fixed **by construction**, not by tuning.

**Accepted tradeoff (Q2), owner decision.** Post-click stillness on a LOCAL consequence (a tooltip or inline expand at the click point) also goes wide — telemetry cannot tell "consequence here" from "consequence elsewhere" (both are click-then-still). This fails **safe** under the standing axiom "a wrong zoom that crops a screen-wide change is worse than a missed one": the miss is a zoom the owner adds by hand.

**Known intent ceiling — documented, not solved (future work).** Telemetry (cursor position + click/scroll events) fundamentally cannot see screen *content* change. The only true fix for "clicked, screen changed elsewhere" is a post-click **frame diff** — decode frames at suggest-time, detect a large region change after a click, release the zoom. That is a new capability beyond telemetry-only detection and is deferred. Everything in this entry is the honest best a telemetry-only detector can do.

**Two tuning dials.** `POST_CLICK_STILL_PX = 60` (post-click bounding-box diagonal counted as "still") and `POST_CLICK_WATCH_S = 0.6` (minimum still duration to read as "watching"). Judged good as-is — a couple of click-and-stay cases still keep the zoom at these values, left in **by choice**, since loosening risks over-veto (killing good zooms). These are the two dials if the balance ever needs revisiting.

**Gate.** 21 zoom + 8 edit-invariant tests green, no warnings; byte-identity/copy-path invariant untouched (exports still ignore zoom). Fixtures re-pinned once: #1 091633 4→2→1 (rule 1 vetoed its post-click-still stop), #2 105816 28→18 (fresh merge un-fuses the over-merges; rule 1 no effect — its clicked dwells have local motion), #3 220817 pinned at 12. The `193209` recording that motivated rule 1 was discarded before a durable fixture could be pinned; the pattern is covered by fixture #1's equivalent plus the synthetic `post_click_stillness_goes_wide` test.

## 2026-07-13 — Zoom step 3 done; step 5 detection pulled ahead of step 4 export rendering

Step 3 (`4de72c4`): annotation pip/band/handle machinery extracted into the shared `SegmentTrack` component and annotations migrated onto it (owner hand-verified identical behavior); manual zoom lane, Zoom panel section (add at playhead, 1.1–2.5x scale, delete), stage crosshair center picker with crop-box edit view, live preview via rAF-driven clamped crop-center CSS transform on the video element only. Segments serialize to the step-2 keyframe schema; empty track stays absent (invariant guards green: cargo 18 passed, tsc/vite clean, segment<->keyframe round-trip harness identity). The TS `zoomAt` interpolation + framing math in Review.tsx is the reference the step-4 export renderer must mirror. Known preview-only gaps, judged acceptable: annotation overlays don't transform during zoomed playback (overlay ordering is step 4's design), and zoomed video can bleed into letterbox bars on non-16:9 sources.

**Reorder (owner):** detection is the actual feature — auto-place zooms from clicks/movement; manual editing is cleanup, and its UX intentionally stays basic. Step 5 runs next, before step 4. This is safe: detection only writes the sidecar zoom track and exports ignore zoom until step 4, so the byte-identity invariant is untouched. Grounding: the C.1 heuristic is a stateless per-recording function — "tune against accumulated telemetry" calibrates thresholds and feeds the C.4 ten-recording gate, but a first pass runs on any post-step-1 recording (verified: today's `.cursor.json` files carry 120 Hz positions, click events with position, video_size, PTS anchor). Expected v1 quality: clicks/travel solid, dwell noisy (parked-cursor false positives — add an activity-recency guard), boundaries approximate; roughly a third to half of suggestions will need cleanup.

**v1 detection ships behind an explicit "Suggest zooms" button.** Auto-run at review-open is a deliberate later decision, made only once the detector is trusted — after step 4, an auto-written track would silently move every save off the `-c:v copy` path. Re-running replaces only `auto_generated` keyframes; any user edit clears the flag (step-2/3 semantics), so regeneration never stomps manual work.

## 2026-07-13 — Zoom step 2 done: sidecar zoom track, absent-when-empty enforced structurally

`SidecarState.zoom: Vec<ZoomKeyframe>` (`t` seconds on the original timeline like `annotation.start_time`; `scale` 1.0 = no zoom; `center_x/y` in video pixel space; `ease` in_out_cubic (default) | linear; `auto_generated`). Nothing reads the field yet — export rendering is step 4, UI is step 3.

**One deviation from the V3-PLAN C.2 sketch: `auto_generated` lives per keyframe, not on the track.** Track-level was specified, but it can't express a track holding both suggested and manual keyframes — the state step 5 + step 3 produce together. Per-keyframe, regeneration replaces only flagged keyframes and manual edits are never stomped, which is the property the flag exists for. It also keeps the track a plain `Vec`, which is what makes the governing invariant structural: `skip_serializing_if = "Vec::is_empty"` (the same convention `bubble_position_log` already uses) means an empty track *cannot* serialize — no normalization code to get wrong. A track-level flag would have forced a wrapper struct with two representations of "empty" and a custom skip.

**Gate results (all runnable, no out-of-repo fixtures):**
- `empty_zoom_serializes_absent_byte_identical_to_pre_zoom` — a no-zoom sidecar exercising every field serializes (in memory and through `write_sidecar_path`) byte-identical to a pin captured from the pre-change code at `e29d638`.
- `zoom_empty_array_input_normalizes_to_absent` — a hand-edited `"zoom": []` parses and re-serializes with the key gone.
- `zoom_track_round_trips_losslessly` — non-empty track survives serialize/parse/disk round-trip; omitted keyframe fields default sanely.
- `empty_zoom_stays_on_video_copy_path` — end-to-end against a synthesized source: no-zoom save keeps the video stream md5 bit-exact (`-c:v copy`) with audio re-encoded. Also pins that a NON-empty track still copies — correct until step 4, which must flip that half to a re-encode assertion.

The copy-path claim is also by construction: `zoom` is referenced nowhere outside the struct definition and tests (grep-verified), so `needs_filter`/`mp4_video_can_copy` inputs are unchanged.

**Fixture-restore urgency unchanged (before step 4, not sooner).** This step adds no video-path behavior for the missing May-fixture guards to catch. The new synth-source test partially covers the `save_recording_baseline` gap (copy-path stream-md5 now has a guard that actually runs), but real-recording baselines are still worth restoring before step 4 introduces genuine re-encoding.

## 2026-07-13 — Zoom step-5 v1 judged: 24/28 keep-worthy; tuning spec locked (owner pass)

First per-zoom eyeball pass on a real ~162s demo recording (28 suggestions; telemetry checked in as fixture `cursor-2026-07-13-105816.json`). Every miss was "too eager," never "wrong place"; long holds landed (a 9.5s and a 6.4s hold both praised); zero requests for center-tracking across all 28 — the fixed-hold model is confirmed and the center-easing hybrid idea stays parked. Verdicts: 20 clean good, 2 hard no (narration dwell on the URL bar; dwell while scrolling a list), 2 would-edit-out (transient "open"-style clicks that earned nothing), 3 too-tight (all mid-screen unclamped centers — edge-clamped zooms never drew one because clamping shows extra context for free), 1 hold-too-short. Structural: three same-spot drags read as click+bogus-mid-drag-dwell and produced out-in-out with the middle drag silently dropped (the merge trim cut a merged window back past click evidence it had absorbed); one "searching for something" episode pulsed in-out-in instead of holding.

**Tuning spec — the next zoom session implements exactly these six, validated against both pinned fixtures, judged by a fresh-recording eyeball pass:**

1. Scale: `SUGGESTED_SCALE` 2.0 -> ~1.7, or interior-aware (shallower for unclamped interior centers).
2. Scroll vetoes clickless dwells. C.1 already says scroll = hold current zoom (wide counts as current); today scroll only extends, never suppresses.
3. Transient-click filter: a click the cursor immediately travels away from, with no dwell or follow-up nearby, is fire-and-forget — stay wide.
4. Drags first-class: pair left_down/left_up; large displacement = one candidate spanning the gesture; drag motion spawns no dwell candidates; the merge trim must never cut past absorbed click evidence.
5. Patience on same-region re-zooms: a next candidate near in both time and space bridges into one hold instead of out-in (also the hold-too-short fix).
6. Narration dwells: accept residual misses rather than over-filter — clickless dwells went 4-for-6 and the two good ones are indistinguishable in telemetry from the bad ones.

Fixture #2 has drags and 46 scroll events that fixture #1 lacks; both pins gate the tuning session.

## 2026-07-13 — Known gap: no way to reopen a recording's review window after it closes

Review windows are created only by the recording `stopped` event handler (App.tsx `openReviewWindow`); once a recording's review closes — window closed, app quit, or crash — there is no UI path back to it. The scratch dir survives (the launch sweeper only collects dirs older than 24h) with sidecar, telemetry, and sources intact, so the data outlives its own edit UI: a user who closes review loses access to an unsaved recording's edits even though every byte is still on disk. Surfaced during zoom step-5 suggestion judging, when a dev-app stop closed the review for a recording with a full suggestion lane.

Dev-mode workaround: spawn the review `WebviewWindow` from the recorder window's devtools console with the same label and URL params the `stopped` handler builds (`review-<stamp>`, `path`/`screenPath`/`webcamPath`/`webcamLeadMs`) — the sidecar restores all edits. Real fix is a small product slice (a "recent recordings" or "reopen last recording" entry point on the recorder); not scheduled. Note the interaction: the 24h scratch sweep bounds how long a closed-review recording stays recoverable.

## 2026-07-13 — Known gap: five stream-md5 fixture guards are non-functional (baseline recordings missing)

Discovered while proving the zoom-layer step 1 gate. `save_recording_baseline`, `mp4_save_baseline`, `probe_audio_track_baseline`, `render_preview_audio_baseline` (edit.rs), and `sprite_smoke` (thumbs.rs) all fail at their first assert — the May 2026 baseline recordings they read from `~/Movies/Zeigen/.scratch-baseline-c1/` (and the sprite test's scratch source) no longer exist on this machine. No pipeline code runs before that assert; the failures are environmental, not regressions. But a byte-identity guard that can't run isn't protecting anything.

**Restore before zoom-layer step 4 (export rendering) — owner's ruling.** Step 4 is where real video re-encoding enters the pipeline, and the stream-md5 guard (`save_recording_baseline`: video stream bit-exact under `-c:v copy`, audio re-encode tolerated) is the thing that catches a copy path accidentally falling through to a re-encode. Restoration is its own small task: stash a fresh baseline recording at the expected path (or repoint the tests at an in-repo fixture like the phase15-baseline used by the tests that still pass) and confirm all five run green.

## 2026-07-13 — Zoom ships as an editable export-time layer; plan approved

Revives V3 Phase C in a shape that honors the 2026-07-11 pivot instead of superseding it — the encoder-floor measurements and the "no re-encode on the default save path" principle stand; this design is built on them. Full plan: `docs/ZOOM-LAYER-PLAN.md`.

**Model:** record normally (raw video untouched, saves stay on the video-copy path); the app suggests zoom moments from the Phase A cursor telemetry; the user edits them on a timeline track; zoom applies only at export. Governing invariant: an empty/wiped zoom track serializes to *absent* (E1 roundness `None` convention), so a no-zoom recording rides today's exact path and guards — the layer can only add. Only zoomed exports pay the measured encoder floor (~29s per 5 min at 1x full res, ~12s per 2-min demo, ~16s at 720p).

**Owner decisions:**

1. **Burned-in cursor scales with zoom at <=2.5x: accepted.** The synthetic cursor is deliberately traded away for the byte-identity/simplicity of the layer model. Eyeball a 2.5x zoom on a real recording during step 3/4; the trade stands regardless.
2. **Swift-vs-ffmpeg export rendering: deferred to step 4, gated like B.0** — pick an approach, measure a real slow-pan zoom for stutter, build only on a smooth result. The overlay-ordering constraint (content-anchored arrow/blur/spotlight zoom with the frame; screen-anchored bubble/watermark do not) is part of that step's design.
3. **GIF: MP4-only for v1.**

**Build order (each step its own session):** (1) decouple telemetry from cursor-hiding and flip it on — `.cursor.json` written with `showsCursor` untouched, saves provably inert, tracks accumulate for tuning; (2) sidecar zoom track + byte-identity guards; (3) generic overlay-timeline track extracted from the existing annotation pips + manual zoom editing + live CSS-transform preview — delivers the queued annotation-duration timeline as a side effect (build the overlay-timeline once, not twice); (4) export rendering behind the measured gate; (5) suggestion detection last (heuristic is V3-PLAN §3 C.1 unchanged, tuned against telemetry accumulated since step 1).

**Scoping facts this rests on (verified 2026-07-13):** Phase A telemetry has everything detection needs — 120 Hz positions in video pixel space, clicks with position on the output timeline, scroll presence, <=8 ms proven alignment — except the flag currently couples telemetry to hiding the cursor; step 1 decouples. The B.0 spike's code is gone (never committed) — rendering is a rebuild from its durable measurements, and its quality argument (ffmpeg `zoompan` integer-offset stutter) motivates the step-4 gate. `Review.tsx` annotation pips already implement drag/resize time-bounded segments, so step 3 is extraction, not new construction.

## 2026-07-13 — Known gap: exported watermark opacity renders lighter than preview (not fixing now)

Observed during watermark size/opacity UAT (feature commit 8d51699): at the same opacity setting, the exported watermark looks noticeably lighter than the stage preview. Likely cause: the two opacity paths differ — preview applies CSS `opacity` on an `<img>` in sRGB compositing; export multiplies the PNG's alpha via ffmpeg `format=rgba,colorchannelmixer=aa=` and then blends inside the yuv420 pipeline. The synthetic pixel check (opaque white logo at aa=0.5 over solid blue) matched preview math exactly, so the mismatch likely involves the real logo's own alpha channel and/or colorspace conversion, not the fraction itself.

Deliberately not fixed now — minor, and the sliders are otherwise correct. When picked up: the fix is making the two paths agree numerically — measure exported vs previewed pixels with the real logo at a few opacity stops, then either adjust the export's alpha curve to match CSS compositing or render the preview through the same math. Size has no such gap (pinned by test + pixel check).

The webcam bubble lagged the voice by ~270ms on every export — noticed 2026-07-11, the first voice+bubble recordings since June. Root-caused by elimination over two days; the constant was recalibrated from a four-clap protocol and verified sub-frame.

### What it was NOT (each disproven with evidence)

- **Not the E1 roundness work:** capture-path diff timing-inert; spawn gaps matched within 4ms; export arg vector pin-proven identical; symptom reproduced on the pre-E1 binary.
- **Not engine code at all:** a rebuilt June-era app (pre faceless-helper, pre permission-recovery) measured the same new offset (+93ms) as the current build — the decisive control test.
- **Not macOS:** machine up 75+ days, no reboot, no update in the window.
- **Not AirPods in the June calibration:** `~/Movies/Zeigen/.sync-measurements.jsonl` (June 9 instrumentation) records `BuiltInMicrophoneDevice` on every calibration take.
- **Not a mis-calibration:** the June log's raw timings (webcam first frame +733-860ms after spawn vs SCK +232-502ms) show 360 was genuinely right, and VizIQ Demo (June 24, warm, built-in mic, bubble) was in sync in production.

### What it WAS

**The environment's camera-open latency dropped ~270ms between June 24 and July 11** — same boot session, cause unrecoverable (camera daemon state / another process warming the camera stack). The constant encodes environment; the environment moved.

Confounder found en route: **macOS Mic Mode = Voice Isolation** had been silently inherited by the engine (faceless helper can't surface the selector; shows as "Unknown" in Control Center), zeroing inter-speech audio and deleting claps — fixed as a setting (Zeigen camera panel → Mic Mode → Standard) and prerequisite to all measurements below.

### Recalibration (2026-07-12)

Four sharp-clap runs, built-in mic + built-in camera, Standard mic mode, prewarm active: true offsets **+88 (cold) / +113 (warm) / +114 (cold) / +119ms (warm)** — 31ms total spread, inside one 30fps frame, cold == warm. New value **105** (midrange, max residual 17ms). End-to-end verification: re-compositing a protocol take with 105 measured **−19ms** export desync (sub-frame). Measurement method: audio clap peak vs webcam motion-energy peak on the raw scratch; for exports, `fps=30` resample first (composited exports are VFR — frame/30 indexing is wrong on them) and back out the tpad.

### Standing consequences

- The constant is **device- and environment-dependent** (bakes in per-mic audio latency and per-camera startup latency — AirPods ~+150-300ms, Continuity camera large/variable). Calibrated for built-in devices only; re-run the clap protocol on any device or engine-startup change. Full warning at the constant.
- The structural fix stays queued: per-recording measurement (engine timestamps each pipeline's first real sample — both clocks are mach-domain, feasibility proven) plus per-device audio-latency compensation. This episode — a validated constant silently rotting from environmental drift — is its justification.

## 2026-07-11 — E1 complete: visual gate passed

Exported bubble matches the recorder-panel live preview across the roundness range, confirmed by eye against real exports (owner's ruling). With the deterministic guards already green (pre-E1 fixture byte-identity, pinned ffmpeg arg vectors, mask geometry tests), E1 is done. Next in the queue, each for its own session: shadow depth strengthening (bubble should read as floating above the background — current shadow calibration is the baseline), E2 export presets (tiers still undecided), and the A/V sync timestamp fix (scoped 2026-07-11; replaces WEBCAM_LEAD_MS with a per-recording measured offset — see that session's plan; the perceived desync that night was primarily the macOS Voice Isolation mic mode gating the engine's audio, a settings fix, plus a real ~270ms bubble lag from the constant).

## 2026-07-11 — E1 placement: roundness is a before-record control, not a Review edit

Supersedes the placement half of the E1 entry below (the rendering mechanism, byte-identity guards, and preview-parity arithmetic all stand unchanged). The Roundness slider moved from the Review toolbar to the recorder panel, next to the camera picker, visible when a camera is selected and locked during countdown/recording. After recording there is no roundness control anywhere.

**Data path:** slider → `set_bubble_roundness` → `settings.json` (remembered default; full circle normalizes to absent, same convention as the sidecar) → captured into the active recording at start → **stamped into the sidecar at finalize**, in the same block that writes `bubble_position_log`. Export reads only the sidecar. Stamping at record-stop rather than reading the preference at export is deliberate: changing the default later never reshapes an existing un-exported recording.

- **Live preview:** the main window pushes `bubble-style` events to the floating bubble window, which binds the value to `border-radius` — the same radius fraction the export mask uses. The bubble window also reads `get_settings` on mount, so a missed event can't leave it stale.
- **Review is read-only for roundness:** the control is gone, but the sidecar field's read→write round trip is kept so Review's debounced auto-save preserves the record-time stamp, and `BubbleLayer` still previews the stamped shape during playback.
- **No recording-engine changes:** the Swift binary never sees the bubble — webcam capture is a separate ffmpeg process, the position log is app-side, compositing is export-time. UI + settings + one sidecar stamp only.
- Shadow deliberately untouched — a depth-look shadow strengthening is queued as the next step and current calibration is the baseline for it.

E1 shipped as roundness-only: one slider making the webcam bubble a rounded square instead of a circle. The size slider was cut from scope before build — size stays driven by the record-time position log exactly as before, which also deleted the need for any precedence rule between record-time and export-time values. Roundness has no record-time counterpart: one optional sidecar field, absent = circle = today.

- **Mechanism:** `composite.rs`'s mask/shadow renderers generalized from a hardcoded circle to a rounded square (four cubic arcs, corner radius = roundness × diameter/2). `SidecarState.bubble_roundness: Option<f64>` (0.0 square … 1.0 circle) threads into both composite call sites; styling bakes in composite pass 1, so MP4/GIF/Copy/R2/LinkedIn all inherit it.
- **Legacy byte-identity is structural, not asserted-after-the-fact:** `None` keeps the pre-E1 `from_circle` branch and the pre-E1 mask filename, and the Review slider writes `null` at the circle end, so an untouched (or returned-to-circle) recording has no field in its sidecar at all. Guards: mask/shadow PNGs captured from the pre-E1 code as fixtures (`tests/fixtures/`), plus the full ffmpeg arg vector pinned for both live filter branches via the new `build_composite_args` split. Full-mp4 byte-identity is not assertable for webcam exports (h264_videotoolbox is not bit-deterministic — see 2026-05-20); identical command + identical mask bytes is the honest equivalent.
- **Preview parity is arithmetic:** CSS `border-radius: roundness × 50%` on the square bubble element equals the mask's roundness × diameter/2, and CSS box-shadow follows border-radius, so the existing shadow calibration needed no retune.
- **Gate:** `e1_roundness_gate` (ignored test, phase15-baseline fixture) renders circle/squircle(0.35)/near-square(0.08) through the real composite path for eyeball comparison against the Review preview.

Synthetic cursor (Phase B) and auto-zoom (Phase C) are dropped. V3's remaining work is export-time polish on the existing ffmpeg pipeline: **E1 — webcam bubble styling** (roundness/size/position controls on the existing `composite.rs` overlay) and **E2 — export presets** (quality/resolution/format at export; tiers deliberately undecided as of this entry). Redaction (Phase D) is unscheduled.

### Why: the encoder is the wall, and the features sat on the wrong side of it

The B.0 compositor gate (V3-PLAN §2) was run before any cursor work, as planned, and failed at **106s against the 15s budget** for a 5-minute Retina-2x recording with one blur region. Root cause is hardware, isolated by measurement, not guessed:

- **VideoToolbox h264 encode runs at ~500 MP/s total on an M4, full stop.** Decode is ~4x faster than encode; the Core Image stages are free (±0.1s); `PrioritizeEncodingSpeedOverQuality` / `RealTime` / `MaximizePowerEfficiency` are accepted (status 0) and change nothing; two concurrent sessions each run exactly 2x slower (the media engine saturates); HEVC is the same rate; ProRes only 2x.
- **A Swift compositor cannot out-encode ffmpeg** — `h264_videotoolbox` is the same silicon; the two measured within 0.1s of each other. The §0.2 "compositor buys save speed" premise is void. (The 2026-05-20 entry's rejected full re-encode — 39.28s for 5 min at 1920x1080 — is the same ~490 MP/s floor, measured a year apart.)
- **Floor for a full re-encode of a 5-minute recording (~8,800 VFR frames): ~95s at Retina 2x, ~29s at 1x (all current recordings — see the `SCDisplay` points finding below), ~16s of encode at a 720p downscale.** Scales linearly with output pixels. Bitrate/quality does not move it. `-c:v copy` is the only instant path.

Cursor smoothing and auto-zoom force a full re-encode of every save that uses them (the cursor must be composited into every frame once it's not burned in), so they inescapably cost the numbers above — either on the default save path (unacceptable wait) or behind capture-time opt-in complexity (two recording families, unrecoverable record-time decisions). Not wanted either way. Export-time polish costs the re-encode only when the user explicitly asks for a differently-shaped export, which is the honest place for it.

These encoder-floor numbers are load-bearing for E2: resolution and format genuinely change export speed, quality does not, and the UI should present estimates accordingly.

### Disposition of the V3 work so far

- **Phase A telemetry: dormant, not reverted.** `capture_cursor` stays pinned `false` in `lib.rs`/`prewarm.rs`; no telemetry is written, the cursor stays burned in, and the byte-identical save guarantee holds by construction. The code (commit `ac4cfb5`) is isolated and its A.2/A.5 alignment work is the expensive part to rebuild if cursor polish ever returns. Do not flip the default without a renderer — a plain save of a cursor-hidden recording has no pointer.
- **B.0 compositor spike: discarded, never committed.** Its measurements (above) are the durable output.

Implements V3-PLAN Phase A. The engine samples cursor position at 120 Hz (`CGEvent(source: nil)?.location`). Details that weren't in the plan, plus one forced deviation:

- **Clicks/scrolls are detected by polling `CGEventSourceCounterForEventType` deltas on the 120 Hz tick — NOT the plan's `NSEvent.addGlobalMonitorForEvents`.** Measured on this machine (macOS 26): global mouse monitors install successfully but silently deliver *nothing* unless the process holds the Input Monitoring TCC permission (`IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)` = denied here; a real click produced zero monitor callbacks across bare-CLI and `NSApplication.shared`-initialized variants, while `CGEventSource` counters and `buttonState` caught the same click with position). The plan's hard constraint was no new permission prompts — the monitor cannot honor it, so it's gone entirely. Counter polling is the same permission-free session-state family as `CGEvent(source: nil)`, catches clicks shorter than one tick, and quantizes event timestamps to ±8.3 ms (well inside the A.5 one-frame gate). Cost: **scroll events carry no `dy`** — direction/magnitude are unobtainable without Input Monitoring. Phase C's heuristic only needs "scrolling is happening → hold zoom," so this is acceptable; revisit only if a future feature genuinely needs scroll deltas, and price in the Input Monitoring prompt at that point. A `CGEventTap` stays off the table (Accessibility permission). main.swift is untouched — polling runs on the sampler's dispatch queue and needs no run loop.
- **Sidecar name is `.<stem>.cursor.json`** (hidden dotfile), mirroring the *actual* convention in `edit.rs:sidecar_path()` (`.<stem>.annotations.json`) rather than the plan's literal `<recording>.cursor.json`. Telemetry is capture-owned and immutable; it is deliberately a separate file from the user-edited annotations sidecar.
- **Anchor semantics:** `first_frame_pts` is the first written frame's position on the *output* timeline (`adjustedPTS - sessionStartPTS`, usually 0.0) so sample `t` values line up with mp4 playback time directly. The mach timestamp is taken at the moment the writer accepts the frame — same callback as receipt, microseconds apart. Pause is handled exactly like the writer handles PTS: samples during pause are dropped and the cumulative paused duration is subtracted, so telemetry stays on the gapless output timeline (verified: 3 s pause produced zero timeline gap > 20 ms). Pause cannot precede the anchor because D-06 rejects pause before writer-start.
- **Samples/events before the first video frame (negative t) are dropped at write time** — there is no video content for them to align with.
- **The app pins `capture_cursor: false`** (`lib.rs`, `prewarm.rs`) until the Phase B compositor exists. The engine default is `true` per the plan, but with no synthetic cursor renderer yet, defaulting the app to telemetry-on would ship cursor-less recordings. Flip to true when Phase B lands.
- **Fatal-error teardown does not write a telemetry sidecar** — it stops sampling and removes the monitor. Partial-save consistency for telemetry can be revisited when something consumes it.
- **Scale finding (matters for the "2x display" gate):** on this machine (macOS 26), `SCDisplay.width` returns **points**, not pixels — the built-in Retina panel (2940x1912 px framebuffer) enumerates as 1470x956, so `scale = SCDisplay.width / frame.width` is 1.0 on every display and all recordings are made at 1x. (The IPC-SPEC `enumerated` example showing 2560x1664 predates this.) The cursor mapping uses the *same* origin/scale formula the session uses for video dimensions, so telemetry coordinates and video pixels cannot diverge regardless of what that formula evaluates to — verified empirically: fullscreen, area (both 1x external and Retina built-in, including cross-display origin offsets), and window capture all produced telemetry coordinates exactly matching the predicted video-pixel positions.
- **Odd window heights:** a 987-pt-tall window encodes as a 986-px mp4 (h264 even-dimension rounding, pre-existing). `video_size` in the telemetry reports the configured 987. Phase B should read the mp4's real dimensions for rendering and treat `video_size` as the mapping space.
- **A.5 alignment gate: CLOSED (redefined 2026-07-11, plan owner's ruling). Phase A complete.** The literal 33 ms bar turned out to measure the Mac's input-to-glass-to-capture latency — mousedown → app render → display refresh → WindowServer composite → SCK frame — whose floor is ~45 ms even for a native AppKit target that flips its own draw path (measured +44…+81 ms per click at 60 fps capture; a Chrome target adds its own ~50 ms on top, +89…+119 ms). No telemetry implementation can clear that bar; an event tap would measure the same gap, since it is downstream of event generation. The gate is therefore redefined to what it protected:
  - **Telemetry-attributable offset ≤ 1 frame: PASSES, proven ≤ 8 ms** — during a live scroll (compositor fast path, minimal render latency), content motion appeared 7.7 ms after the telemetry event, bounding any anchor/clock offset; counter-poll detection lag is ≤ 8.3 ms by construction.
  - **No drift: PASSES** — video-PTS rate vs mach clock measured at +0.043 ms/s (2.6 ms/min) by regressing 47 once-per-second timer repaints across a 48 s window; early vs late click clusters ~60 s apart matched within one capture frame (+47.2 ms vs +56.3 ms mean, +9.1 ms shift).
  - The **~50 ms residual is downstream render + capture latency**, evidenced by (1) duration match: telemetry press-hold durations equal video white-flash durations click-for-click within one frame, i.e. both edges carry the same constant offset; and (2) target swap: replacing Chrome with the native flip window removed exactly the browser's input-to-paint share.

  Note for Phase B: a click ring rendered at telemetry t will lead the UI's visible reaction by 1–2 frames (30 fps) — faithful to what the live screen did, but B may want a +1 frame render bias on the ring if the lead reads badly. Verification artifacts (flip-target app, per-click analysis) live outside the repo; the method is reproducible from this entry.

## 2026-05-20 — Always-on arnndn on MP4 export; noop saves keep source video via `-c:v copy`

Phase 12 makes ffmpeg's `arnndn` noise reduction always-on for every MP4 save (`-af arnndn=m=<bundled-rnnoise>.rnnn`, applied between demuxer trim and AAC encode). The RNNoise model (`cb.rnnn` from GregorR/rnnoise-models, ~300 KB) ships under `Contents/Resources/resources/audio/` via `tauri.conf.json` bundle.resources.

The framing is narrower than the original c3 sketch: **audio always re-encodes (for arnndn). Video re-encodes only when there's actual video work** — trim, overlays, or scale. When the sidecar is a noop and the user picks MP4 Source resolution, the pipeline uses `-c:v copy` and runs only the audio side. The pre-Phase-12 `is_edit_pipeline_noop` hard-link short-circuit is removed (always-on NR requires a real audio pass), but the spirit — don't do work that doesn't need doing — is preserved on the video side.

### Trade-off

Background noise (HVAC, fan, room hum) was clearly audible in Phase 11 recordings. The "always-on, no UI" choice avoids a per-recording toggle whose state wouldn't persist anyway (settings reset on restart) and surfaces a configuration decision users shouldn't have to make for every recording. Capture-side NR would touch raw scratch and break the Phase 5.5/11 "scratch stays reversible" invariant, so NR lives on the export side.

### Save-speed regression (measured during c3 verification)

Three concat-loop fixtures (built from the 21.8s Phase 10 baseline-c1 recording at 1920x1080), three runs each, averaged. Apple M-series hardware (h264_videotoolbox HW-accelerated). MP4 Source, empty sidecar.

| Recording length | Pre-c3 (hard-link) | Full-re-encode variant (rejected) | Shipped: video-copy + audio-only re-encode | Delta vs pre-c3 |
|---|---|---|---|---|
| ~30s (43.7s) | 0.05s | 5.88s | 0.85s | +0.80s |
| ~2min (131s) | 0.05s | 16.94s | 2.48s | +2.43s |
| ~5min (305.6s) | 0.05s | 39.28s | 5.68s | +5.63s |

The initial implementation ran `-c:v h264_videotoolbox` on every MP4 save and hit 39s on a 5-min recording — well past the plan's "more than ~10s → flag" threshold. Component breakdown showed the video re-encode was the entire cost (arnndn alone is ~6s on a 5-min). The refined shape `-c:v copy + arnndn + AAC` brought 5-min down to 5.7s while keeping the source video stream byte-exact (verified by stream md5 in `save_recording_baseline`).

Side effect of the refinement: the noop save also preserves source file size. The full-re-encode variant inflated a 208 MB source to 231 MB (+11%) because `-b:v 8M` overshot the source's native bitrate; the video-copy path keeps it at 208 MB.

### Scope

- MP4 saves only — GIF is silent (`-af` not added on GIF mode).
- LinkedIn export chains `save_recording(mp4, source)` (Phase 11 c4), so LinkedIn output inherits the noise reduction automatically.
- Copy-to-Clipboard runs the same pipeline (Phase 11 c2) — also inherits.
- Recordings with no audio stream: `-af` is a clean no-op, no special handling needed.

### Implementation notes

- The model path resolves from `AppHandle::path().resource_dir().join("resources/audio/rnnoise.rnnn")` and is cached in a module-level `OnceLock<PathBuf>` in `edit.rs`. Missing model surfaces as a clear ffmpeg error at first save, not a silent skip.
- `mp4_video_can_copy` inside `run_edit_pipeline` is true iff `trim.is_none()` AND `!needs_filter` (no overlays, no scale). Same condition the deleted `is_edit_pipeline_noop` helper computed at the call site; now inlined where the rest of the pipeline state already lives.

### Known edge case: quiet-input speech suppression

RNNoise has an effective speech-detection floor around RMS -40 dB. At normal recording levels (-25 to -33 dB RMS) the model correctly identifies speech and only attenuates the non-speech regions (verified: peak/RMS shift under 1 dB). On unusually quiet captures (around -44 dB RMS in one observed case), the model can't reliably distinguish speech from noise and suppresses both — the saved file came out 24 dB quieter than source. All five GregorR models (cb, bd, mp, lq, sh) showed the same behavior on that recording; pre-gain into the filter chain didn't recover the speech either.

Surfaced once during c3 verification (2026-05-20). Not reproducible after a fresh dev/engine restart — same physical setup produced a normal-level recording. Suspected causes (none confirmed): stale engine subprocess state, transient macOS audio routing, mic positioning drift. If a future user reports "voice disappeared from a saved recording," check the source scratch's RMS first — if below -40 dB the input itself was the problem, not the pipeline.

---

## 2026-05-20 — Record another disables during active save (D-04 exception)

PHASE-11-CONTEXT D-04 said Record another stays active in all states (pre-commit, mid-save, post-commit). In practice "all states" assumed a normal flow, not an in-flight save. Clicking Record another mid-save fires `discard_recording` against the scratch directory while ffmpeg is still reading it — same shape as the bugs that produced the 119 GB orphan-cleanup incident.

The button now disables when `saving === true` (in addition to the existing `discarding` gate). Otherwise it remains active in every state — including post-save, which is what D-04 was really protecting.

## 2026-05-20 — Sidecar change invalidates the LinkedIn MP4 baseline cache

Phase 11 c4 added `committedMp4Path` so the LinkedIn export chain reuses the most recent MP4 save instead of producing a fresh `recording-<stamp>-N.mp4` every click. But that cache goes stale the moment the user edits the sidecar (trim, text, arrow) after a save: a subsequent LinkedIn click would otherwise ship the old bake.

The debounced sidecar-write effect now also calls `setCommittedMp4Path(null)`, so the next LinkedIn click chains a fresh `save_recording({mp4, source})` against the live sidecar. The cost is one extra ffmpeg pass per LinkedIn-after-edit; the alternative — silently shipping stale edits — is the worse failure mode.

## 2026-05-19 — Save unifies commit + export; scratch + sidecar stay live until close

Every Phase 11 save re-reads the raw scratch mp4 + current sidecar and produces a fresh file in `~/Movies/Zeigen/`. The scratch directory is **not** removed on first save anymore — it survives until the review window closes (red X, Record another, Discard, app close). Subsequent saves in the same session re-read raw + live sidecar and write a new collision slot (`recording-<stamp>.<ext>`, `-2.<ext>`, ...).

Supersedes the Phase 5.5 single-commit lifecycle, where the first save renamed scratch → final and locked the recording. The trade-off:

- **Benefit:** edits stay editable across saves. A user who saves MP4-720p, watches it, and notices a bad trim can fix the sidecar and re-save without re-recording.
- **Cost:** one ffmpeg pass per save, even when the user is only changing resolution. Acceptable — saves are user-initiated, not hot-path; and the "single ffmpeg invocation per save" rule from PHASE-11-CONTEXT line 18 is preserved (every save is exactly one pass; thumbnail extraction is a separate background spawn and doesn't count).

The noop MP4-Source path remains zero-ffmpeg: `std::fs::hard_link` with `std::fs::copy` fallback.

## 2026-05-19 — MP4 default resolution: 1080p

`save_recording` defaults MP4 to 1080p across the `[ 480p | 720p | 1080p | Source ]` preset set. Large-display captures (often >3840px wide on Studio Display / external 4K monitors) produce source mp4s that are unwieldy to share — recipients struggle to download, open, or paste them into other tools. 1080p is the widely-shareable sweet spot for screencast/demo material. `Source` remains available for max-quality archival.

GIF default stays at 720p (Phase 10 D-01). The defaults differ because MP4 is the primary share format and GIF is the lossy auxiliary.

## 2026-04-26 — DisplayLink-driven displays don't get overlay UI

DisplayLink (and other third-party USB-to-video extension drivers) register their virtual displays with `CGDisplay` and `ScreenCaptureKit`, so they enumerate in the Screen dropdown and record correctly. They are NOT first-class `NSScreen`s, and `NSWindow.setFrame:display:` placement on coordinates inside their bounds is silently dropped or clamped by macOS. This affects the countdown overlay (Phase 3.5) and the Identify-display button (Phase 7) — neither will render on a DisplayLink screen even though the math is correct for native displays.

No application-layer fix exists. Workarounds floating around (private APIs, kernel shims) aren't worth shipping for a personal demo tool. Documented as a known limitation in README and CLAUDE.md gotchas.

## 2026-04-26 — Phase 7 ships three of six deliverables

Capture window sizing, identify-display button, and the new app icon ship. Recording preset picker, settings persistence, error surface, and DMG installer are deferred to a future polish phase. Rationale: the three shipped items address concrete UX friction the user kept hitting; the deferred items are either YAGNI for the immediate use case (preset picker — the user's demos are always 16:9) or have natural homes in a separate ship-prep phase (DMG, settings persistence, error surface).

## 2026-04-26 — Phase 6 ships local + clipboard + LinkedIn destinations only

Hosted "Upload & Share Link" is deliberately out of scope. The path requires either user-supplied Cloudflare credentials (too much friction for a personal demo tool) or a hosted backend (significant infrastructure, costs, and ongoing liability). Zeigen is positioned as a local recording tool with smart export paths, not a hosted sharing service. The roadmap originally enumerated R2 + Pages + SigV4 + viewer site; none of that ships, and no follow-up phase is planned.

## 2026-04-26 — Phase 6 uses iPhone screenshot semantics for review-window lifecycle

Closing the review window discards the recording — no prompt. Save and Discard are explicit footer buttons; everything else (close, no choice) defaults to discard. Copy to Clipboard and LinkedIn export are independent destinations that produce temp/separate files without committing the source recording. The Phase 5.5 Save/Discard/Cancel close-prompt is removed entirely.

This reverses the close-prompt portion of the 2026-04-25 "Recordings go to scratch on finalize" entry. The scratch-on-finalize part stands; the modal does not. Rationale: independent destinations made the close-prompt confusing because users could have already used the recording (clipboard, LinkedIn) before deciding whether to keep the local copy.

Implementation:
- Footer "Save recording" — commits scratch → final. Optional. Window stays open after commit so the user can use the export rows. Reveal-in-Finder affordance appears next to the disabled "Saved" pseudo-button.
- Footer "Discard recording" — destructive, deletes scratch + per-recording temp dir. No confirm modal — the click is itself the explicit choice. Disabled after Save (scratch is gone).
- "Record another" — same cleanup as Discard, then emits `record-another`, then closes.
- Close window (title bar X) — when committed, silent cleanup + destroy. When uncommitted, shows a Save / Discard / Cancel modal (Discard default, matching the original Phase 5.5 modal). Rationale for keeping this one prompt: the red X is an ambiguous gesture (users habitually close windows), unlike the explicit footer Discard click. Without confirmation, accidental close → silent discard punishes the wrong instinct.
- Copy to Clipboard row — copies the source mp4 to `~/Library/Caches/com.zeigen.app/exports/recording-<stamp>/` and points NSPasteboard at the temp copy. Does not commit. Available regardless of save state.
- Export for LinkedIn row — produces a separate `recording-<stamp>-linkedin.mp4` in `~/Movies/Zeigen/`. Does not commit the original. The LinkedIn-preset file persists across all cleanup events. (Wired in a follow-up commit; row shows "Soon" in this commit.)
- The Saved Locally row is removed — Save lives only on the footer.
- Temp files cleaned on Discard, close, "Record another." App-launch sweep removes any per-recording temp dir older than 24h. No app-quit cleanup.

UX consequence the user accepted: copying to clipboard then closing the review window invalidates the paste — NSPasteboard's fileURL points at a now-deleted temp file. Documented behavior consistent with the iPhone-screenshot framing ("explicit Save = keep, anything else = throw away").

## 2026-04-25 — Webcam mirror handling

Composite applies `hflip` to match the preview's `scaleX(-1)`. Result is preview/recording always match each other; absolute orientation depends on whether the camera pre-mirrors (Continuity does, FaceTime HD does not).

## 2026-04-25 — Recordings go to scratch on finalize, not final path

Recording-finalize writes the composited mp4 to `~/Movies/Zeigen/.scratch/<id>/` and the review window operates on that scratch file. The final commit to `~/Movies/Zeigen/recording-….mp4` requires an explicit user **Save** action; **Discard** deletes the scratch dir in full. Closing review with unsaved state prompts Save/Discard/Cancel (Discard default). Matches the mental model of all comparable tools (Loom, CleanShot X, QuickTime, ScreenFlow). The previous auto-save behavior was a Phase 5 implementation choice that conflicted with this model — corrected in Phase 5.5.

## 2026-04-25 — `--warning` token added for length-cap 80% tint

`--warning: oklch(0.72 0.16 70)` and `--warning-tint: oklch(0.82 0.14 70)`. Family-consistent with the existing `--accent` / `--recording` / `--success` triplet (all chroma ~0.16, hue 70 between recording's 25 and success's 155), but lifted to lightness 0.72 — pure 0.62 read muddy on the dark bubble pill at 11px. The 100% length-cap state reuses `--recording`. `--warning` does not get a paired bg/surface token; `--recording` doesn't have one either.

## 2026-04-25 — Bubble position log: array-only schema from introduction

`bubble_position_log` lands as an array of `{t, x, y}` entries from day one. No scalar `bubble_position` form was ever shipped, so there is no backward-compat fallback to a "single-entry log at t=0" — that path was speculatively documented during planning and removed once the implementation surface was clear.

## 2026-04-25 — Bubble position log coordinates: fractions of the recorded display, clamped

`x` and `y` in the log are fractions [0..1] of the *recorded display's* physical pixel frame (origin and size sent into `engine_start` from React via `availableMonitors()`). If the user drags the bubble off the recorded display onto another, coordinates clamp to [0, 1] — the composite overlay sticks to the nearest edge rather than disappearing or rendering off-frame. Multi-display correctness for picking the right monitor falls back to size-match in the rare ambiguous case.

## 2026-04-25 — Webcam bubble draggable, free drag with corner snapping, pre-record and during-record

Matches Loom and CleanShot. Position adjustable mid-record so users can move the bubble out of the way of content they're demoing.

## 2026-04-25 — Countdown duration / skip semantics

5s / 3s / Off as the user-facing knob. No separate "skip hotkey toggle" setting — the right control is duration, not a parallel skip mechanism. Esc cancels (no recording starts), Spacebar/Enter skips (recording starts immediately). Countdown is not baked into the recording.

## 2026-04-25 — Timer primary surface on the webcam bubble, not the menu bar

Users look at the bubble constantly during recording (they're checking themselves on camera). Menu bar requires eyes-up movement that defeats the "am I close to my limit" use case. Standalone draggable chip is the fallback when no webcam. Menu bar is secondary backup, free to add since the tray icon already exists.

## 2026-04-25 — Length cap is a warning, not enforcement; 80% / 100% thresholds are not user-configurable

Recording never auto-stops at the cap. Warning tints (orange at 80%, red at 100%) live on the bubble/chip surface only — menu bar stays visually clean. Thresholds fixed for now; YAGNI on configurability until someone asks.

## 2026-04-25 — `makeCaptureInvisible()` shared utility

All floating windows visible during recording must call it (sets `NSWindow.sharingType = .none` so SCK doesn't capture them). Consumers: floating preview, countdown overlay, draggable bubble, standalone timer chip. Single utility, multiple consumers — prevents the Phase 5 two-bubble class of bug from recurring.

## 2026-04-25 — "Discard edits" is non-destructive

The Phase 5 footer's "Discard edits" button resets trim handles and clears annotation overlays — it does not delete the source recording. Destructive delete is deferred to a future phase with a confirmation dialog. The mockup's original "Discard recording" wording was too aggressive for review-screen UX.

## 2026-04-25 — Phase 5 scaffolds the Phase 6 export panel disabled

Review window ships with the full Phase 6 export panel rendered at visual fidelity but inert (opacity 0.4, `pointer-events: none`, "Coming in Phase 6" caption). Phase 6 only removes the disable. Avoids re-laying out the window when Phase 6 lands and gives the user a visible roadmap.

## 2026-04-25 — Review window is a separate Tauri window

Recording stop opens a new Tauri window labeled `review`; main window stays hidden through Phase 4 and into review. Keeps capture and review concerns isolated and future-proofs for multi-recording flows. Mockup sizing (940px) is the reference.

## 2026-04-25 — Phase 5 trim re-encodes via VideoToolbox

Trim always re-encodes through `h264_videotoolbox`. No stream-copy keyframe-snap fast path. Frame accuracy beats UX surprises where cuts silently land on the nearest keyframe. Hardware encoding makes the cost negligible on Apple Silicon.

## 2026-04-25 — Share link expiration: none

Links are permanent. Mockup proposed 30 days; rejected to keep behavior simple. No expiration UI, no cleanup job.

## 2026-04-25 — Custom domain: no

Use the default Cloudflare Pages subdomain (e.g., `zeigen-share.pages.dev`). Custom domain adds DNS, cert renewal, and an external dependency without proportional value for a personal tool.

## 2026-04-25 — Old `~/Movies/Dashcast/` recordings: leave in place

No auto-migration on first Zeigen launch. Folder is harmless. Move or delete manually if/when desired.

## 2026-04-25 — Public name: Zeigen (not a codename)

Treat as final. Titlebars, save paths, viewer UI, share URLs all use "Zeigen." Pronunciation: TSIGH-gen (German "to show").

## 2026-04-25 — Tauri bundle ID: com.zeigen.app

Renamed from `com.dashcast.app` while still in dev. No installed builds in the wild, so no migration needed.
