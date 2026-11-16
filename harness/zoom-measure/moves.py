import csv, sys, numpy as np
name = sys.argv[1]; wide = float(sys.argv[2]); detail = [float(x) for x in sys.argv[3:]]
R = list(csv.DictReader(open(name + '.csv')))
f = lambda k: np.array([float(r[k]) for r in R])
S = f('S') / wide; cx = f('cx'); cy = f('cy'); sh = f('sharp'); ds = f('ds'); dx = f('dx'); dy = f('dy')
W, H = 1280, 660
# output-space motion per frame at a point 1/4 frame from centre (px/frame @1280 wide): scale part + translation part
mv = np.hypot((ds - 1) * W / 4 + 0, 0) + np.hypot(dx + (ds - 1) * W / 2, dy + (ds - 1) * H / 2)
spd = np.hypot((ds-1)*W/2 + dx, (ds-1)*H/2 + dy)        # centre-of-frame speed
cor = (np.abs(ds - 1) * np.hypot(W, H) / 2) + np.hypot((ds-1)*W/2 + dx, (ds-1)*H/2 + dy)  # ~corner speed upper bound
moving = cor > 0.6
# group into moves, bridging gaps <= 3 frames
moves = []; i = 0; n = len(S)
while i < n:
    if moving[i]:
        j = i; gap = 0; last = i
        while j + 1 < n and gap <= 3:
            j += 1
            if moving[j]: last = j; gap = 0
            else: gap += 1
        moves.append((i - 1, last)); i = last + 1
    else: i += 1
print(f"{name}: {len(moves)} camera moves")
print(" start   dur   scale          centre(src px@1280)            kind    peak px/f  t50%  over%  sharp(min/rest)")
for a, b in moves:
    a = max(a, 0); dur = (b - a) / 30
    if dur < 0.1: continue
    s0, s1 = S[a], S[b]; c0 = (cx[a], cy[a]); c1 = (cx[b], cy[b])
    dz = abs(s1 - s0) > 0.03; dp = np.hypot(c1[0]-c0[0], c1[1]-c0[1])
    kind = ('zoom-in' if s1 > s0 else 'zoom-out') if dz else 'PAN'
    # progress curve on the dominant quantity
    if dz: p = (S[a:b+1] - s0) / (s1 - s0)
    else:
        d = np.array([c1[0]-c0[0], c1[1]-c0[1]]); p = ((cx[a:b+1]-c0[0])*d[0] + (cy[a:b+1]-c0[1])*d[1]) / max(d@d, 1e-9)
    t50 = np.argmax(p >= 0.5) / max(b - a, 1); over = (p.max() - 1) * 100
    t10 = np.argmax(p >= 0.1); t90 = np.argmax(p >= 0.9)
    rest = np.median(np.r_[sh[max(a-8,0):max(a-1,1)], sh[b+2:b+9]]) if b + 9 < n else sh[max(a-8,0):a].mean()
    print(f"{a/30:6.2f} {dur:5.2f}  {s0:4.2f}->{s1:4.2f}  ({c0[0]:4.0f},{c0[1]:3.0f})->({c1[0]:4.0f},{c1[1]:3.0f}) {dp:4.0f}px {kind:8s} {cor[a:b+1].max():6.0f}  {t50:4.2f} {over:5.1f}  {sh[a+1:b].min()/rest if b-a>2 else 1:4.2f}  10-90:{(t90-t10)/30:.2f}s")
    if any(abs(a/30 - d) < 0.4 for d in detail):
        print("    progress per frame:", ' '.join(f"{x:.2f}" for x in p))
        print("    sharp/rest        :", ' '.join(f"{x/rest:.2f}" for x in sh[a:b+1]))
