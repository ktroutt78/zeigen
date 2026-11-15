# First assignment: zoom polish + window capture

Keith records demos and walkthroughs with Zeigen almost every day, and right now he turns zoom off on every recording because it hurts the video. The goal is zooms he leaves on.

Start by investigating. Read the code and find the root causes, then come back with a plan for each item. Don't start implementing until Keith has seen the plan.

## 1. Zoom feels harsh (preview AND export)

**What Keith sees:** the zoom "just happens" and whips into place. It works sometimes, but it's often off-target and fiddly to adjust on the timeline. It lacks the polish of Screen Studio.

**What good looks like:**
- Camera moves glide and settle. They should feel physical (spring or critically damped), not a linear or ease-in-out snap.
- Motion blur while the camera is moving, none while it's at rest.
- Back-to-back zooms flow into each other. Don't zoom all the way out and back in between two nearby targets; pan across instead.
- While zoomed, the camera follows the cursor gently, with a dead zone, so it doesn't jitter on small movements.
- The preview is a faithful picture of the export.
- Adjusting a zoom on the timeline (position, duration, target, scale) is direct and predictable.

**Questions to answer in the plan:**
- Are the preview and export computing camera motion separately? If so, the fix is probably one shared camera-path function that both renderers sample, not tuning two copies.
- How to render motion blur in export (temporal supersampling vs. velocity-based directional blur) and what each costs in export time.
- Which "way off" cases are detector problems (wrong time or target) and which are motion problems (right target, bad movement)? Fix motion first. It's the bigger polish win and it affects manual zooms too.

**Auto-zoom picks odd moments.** Keith: "it sometimes just zooms on things and I'm not sure why." The detector isn't as smart as he expects, and right now he can't tell what it's reacting to.
- Make every auto zoom explainable. Record why each one fired (the signal, e.g. click cluster, typing, cursor dwell, plus a confidence score), and let Keith see that reason on the timeline segment. Do this before tuning anything, because without it neither of you can tell a bad rule from a bad threshold.
- Then make the rules stricter: fewer zooms with higher confidence. A missing zoom costs Keith one manual add, while a wrong one ruins the shot.
- Propose a small set of reference recordings Keith can make once, plus his "should / shouldn't have zoomed" calls on them, so detector changes are judged against the same clips every time.

## 2. Window capture misses popups

**What Keith sees:** if he picks a single app window to record and that app opens a popup (menu, dropdown, dialog, popover), the popup isn't in the recording. So he falls back to full-screen every time.

**What good looks like:** recording "this app" includes everything that app draws on top of its window: menus, sheets, popovers, dialogs.

**Likely cause to check:** capture is probably filtered to the single window, so other windows from the same app (popups are often separate windows) get dropped. A common approach is to capture the display, filtered to all windows of the app's process, cropped to the main window's bounds plus some margin. Verify how Zeigen captures today, then propose an approach. Note that some popups are owned by system processes rather than the app.

## Reference: Screen Studio and Cap

Screen Studio is the bar for how zoom should feel, but Keith has no license, so there's no Screen Studio clip to measure. Use Cap (cap.so) as the reference you can measure and read:
- Cap is an open-source Tauri screen recorder with auto-zoom from clicks, zoom glide, a screen-movement spring and screen motion blur. Source: https://github.com/CapSoftware/Cap
- Read how Cap builds its camera path, spring, auto-zoom segments and motion blur. Study it for approach only. Cap is mostly AGPLv3: don't copy its code into Zeigen.
- If Keith provides a Cap export, measure it against the Zeigen export of the same script: extract frames with ffmpeg and plot zoom scale and camera center over time (easing curve, transition duration, settle, when blur appears, what each zooms on). Use these clips as the reference set for judging the fix.
- Match the feel, not the implementation. cicompositor stays the single render path.

## 3. Then: the backlog

After these two, keep a running `docs/BACKLOG.md` of the "little things" Keith mentions. Group them, propose an order, and let him re-rank.
