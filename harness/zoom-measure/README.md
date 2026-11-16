# zoom-measure

Recovers the camera path (scale + centre per frame) from any exported video by
registering each frame against the previous one, then summarizes every camera
move. Used to compare Zeigen exports against the Cap reference
(`docs/ZOOM-POLISH-PLAN.md`, measurement table).

    uv venv -p 3.13 venv && uv pip install -p venv/bin/python opencv-python-headless numpy
    venv/bin/python track.py <video.mp4> out.csv
    venv/bin/python moves.py out <wide-scale> [t ...]

`moves.py` takes the csv name without `.csv`, the tracked scale that
corresponds to the un-zoomed view (1.0 when the clip starts wide; `cap.mp4`
starts zoomed, its wide state is 0.8115), and optional times (s) at which to
print the per-frame progress curve.

Columns: start, duration, scale from->to, centre, kind, peak on-screen speed
(px/frame at 1280 wide), t50 (fraction of the move's time at which half is
done: 0.5 = symmetric, ~0.27 = fast start / soft landing), overshoot %.

Limits: scrolling content reads as a small camera move; the bottom-right
webcam bubble region is masked out.
