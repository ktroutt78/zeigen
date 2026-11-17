# Brief: lighter UI pass + compact capture window

Keith's feedback: Zeigen's UI feels heavy and dated. The cause is the structure, not the colours: too many boxes inside boxes. The layout itself is good; keep it.

Mockups, approved direction: `docs/design/review-lighter.dc.html` (Review), `docs/design/capture-compact.dc.html` (capture window) and `docs/design/recordings-library.dc.html` (Recordings). They're static HTML sketches using Zeigen's own tokens. Read them for intent, spacing and hierarchy. Treat them as a guide, not a pixel spec.

## The rule: one background layer per area

Cap's editor is the model: three panels (preview, controls, timeline) sitting directly on the window background. Inside a panel, no further cards or fills. Only the controls themselves (segmented controls, sliders, buttons) carry a background.

Places Keith pointed out:
- **Timeline:** a darker container holds a lighter rounded panel, which holds the rows, and each row has its own bordered box. Keep one timeline panel. Rows get at most a barely visible fill with no border.
- **Background panel** (and every other settings panel): the panel holds a lighter card that holds the controls. Drop the card, so the settings sit straight on the panel.
- Apply this everywhere: Review, the Recordings window and the capture window.

## Other style changes (from the mockup)
- Sentence-case headings and labels ("Cursor", "Export", "Video", "Zoom"), not spaced ALL CAPS.
- A lighter export area: a normal-height primary Save button, copy-to-clipboard as a small icon button beside it, and Record another / Discard as quiet text buttons.
- Slightly taller timeline rows.
- Notes and toasts never cover controls. The "2 zooms suggested" bar currently covers the Scene row and the Discard button. Drop it; the zooms appearing is feedback enough.

## Compact capture window
Like Cap's launcher, in Zeigen's style. See `capture-compact.dc.html`:
- Settings (hotkey, countdown, length cap, noise reduction) move behind a gear icon in the header. Recordings is an icon beside it.
- Three source tiles: Display, Window, Area. **Webcam only is dropped.** Keith will record a display and switch to a Full webcam scene instead. Remove the disabled "Coming soon" tile.
- **Hover to pick, on every display.** Clicking Display immediately highlights whichever screen the mouse is over, on all displays; a click picks it. Clicking Window does the same for the window under the mouse, on all displays. Area stays as it is. The picker line under the tiles shows the current pick, with Identify next to it.
  - Known obstacle (CLAUDE.md gotcha): macOS only sends `mouseMoved` to the key window, so one hover overlay per display only works on the primary display. That's why the window picker's hover works only on the primary today. The fix already noted there is one overlay spanning all displays, or tracking the mouse position directly instead of relying on `mouseMoved`. Prove which works, including on BenQ (1), the InstantView display.
- Camera and microphone as two rows, each with an On/Off pill.
- A large Start recording button showing the hotkey, with one quiet line underneath (countdown and save folder).
- Behaviour stays the same; only the layout changes.

## Recordings window: a library, not a list
See `docs/design/recordings-library.dc.html`. Keith can't tell recordings apart from a text list.
- A grid of compact cards, four across in the default window (more as it widens). Keith wants the thumbnails smaller than in the first mockup. Each has a 16:9 thumbnail, the duration on the thumbnail, the name, and "time · size" below.
- Grouped by day: Today, Yesterday, then dates.
- Click a card to open it. Delete (and later Show in Finder) goes in a "…" menu that appears on hover, not a button on every row.
- A header with the count, total space and "kept for 30 days", plus a search box filtering by name.
- Thumbnail source: the Mark/poster frame if one is set, otherwise a frame about a second in. **Not the first frame**, which is often black (separate bug). Generate it once and store it in the recording's folder, so the list doesn't decode video every time it opens. Recordings from before naming existed show a fallback name ("Window recording" etc.).

## Process
Propose a short plan first: what changes per window, and anything in the mockups that doesn't fit how the app works. Then build in steps Keith can check: Review first, then Recordings, then capture.
