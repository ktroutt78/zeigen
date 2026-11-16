import cv2, numpy as np, sys, csv
path, out = sys.argv[1], sys.argv[2]
W, H = 1280, 660
cap = cv2.VideoCapture(path)
mask = np.full((H, W), 255, np.uint8)
mask[int(H*0.55):, int(W*0.74):] = 0      # webcam bubble (screen-anchored)
def prep(f):
    g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
    if g.shape != (H, W): g = cv2.resize(g, (W, H), interpolation=cv2.INTER_AREA)
    return g
lk = dict(winSize=(31, 31), maxLevel=5, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 0.01))
orb = cv2.ORB_create(3000)
bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
def est(a, b):
    p = cv2.goodFeaturesToTrack(a, 1500, 0.01, 6, mask=mask)
    best = None
    if p is not None and len(p) >= 30:
        q, st, _ = cv2.calcOpticalFlowPyrLK(a, b, p, None, **lk)
        p2, st2, _ = cv2.calcOpticalFlowPyrLK(b, a, q, None, **lk)
        ok = (st.ravel() == 1) & (st2.ravel() == 1) & (np.linalg.norm((p - p2).reshape(-1, 2), axis=1) < 0.7)
        if ok.sum() >= 20:
            M, inl = cv2.estimateAffinePartial2D(p[ok], q[ok], method=cv2.RANSAC, ransacReprojThreshold=1.0)
            if M is not None: best = (M, int(inl.sum()), int(ok.sum()), 'lk')
    if best is None or best[1] < 0.5 * best[2] or best[1] < 40:
        ka, da = orb.detectAndCompute(a, mask); kb, db = orb.detectAndCompute(b, mask)
        if da is not None and db is not None:
            m = bf.match(da, db)
            if len(m) >= 20:
                pa = np.float32([ka[x.queryIdx].pt for x in m]); pb = np.float32([kb[x.trainIdx].pt for x in m])
                M, inl = cv2.estimateAffinePartial2D(pa, pb, method=cv2.RANSAC, ransacReprojThreshold=2.0)
                if M is not None and (best is None or inl.sum() > best[1]): best = (M, int(inl.sum()), len(m), 'orb')
    return best
ok, f = cap.read(); prev = prep(f)
S, tx, ty = 1.0, 0.0, 0.0   # frame = S*src + t  (relative to frame 0)
rows = []; i = 0
def sharp(g): return float(cv2.Laplacian(g[:int(H*0.5)], cv2.CV_64F).var())
rows.append((0, 1.0, W/2, H/2, 0, 0, 'init', sharp(prev), 1.0, 0, 0))
while True:
    ok, f = cap.read()
    if not ok: break
    i += 1; g = prep(f)
    r = est(prev, g)
    if r is None: ds, dx, dy, inl, n, how = 1.0, 0.0, 0.0, 0, 0, 'none'
    else:
        M, inl, n, how = r
        ds = float(np.hypot(M[0, 0], M[1, 0])); dx, dy = float(M[0, 2]), float(M[1, 2])
        if abs(ds - 1) < 0.0004 and abs(dx) < 0.08 and abs(dy) < 0.08: ds, dx, dy = 1.0, 0.0, 0.0  # dead-band vs drift
    S, tx, ty = ds * S, ds * tx + dx, ds * ty + dy
    rows.append((i, S, (W/2 - tx)/S, (H/2 - ty)/S, inl, n, how, sharp(g), ds, dx, dy))
    prev = g
with open(out, 'w', newline='') as fh:
    w = csv.writer(fh); w.writerow('frame S cx cy inl n how sharp ds dx dy'.split()); w.writerows(rows)
print(out, len(rows))
