// Cross-language transform pin (REDACTION-PLAN commit 4). Proves the TS preview's
// rect-through-zoom (src/redaction.ts sourceRectToOutputRect) agrees with the Swift
// compositor to the pixel, so a box sized with margin in the preview cannot be
// exposed in the export. Run: node --experimental-strip-types transform-pin.ts
//   (needs swiftc + /opt/homebrew/bin/ffmpeg; builds the compositor into a tmp dir)
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sourceRectToOutputRect,
  redactRadius,
  type RedactionRegion,
} from "../../../src/redaction.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FF = "/opt/homebrew/bin/ffmpeg";
const WORK = mkdtempSync(join(tmpdir(), "redact-pin-"));
let failures = 0;

function sh(cmd: string) {
  execSync(cmd, { stdio: ["ignore", "ignore", "pipe"] });
}

// Build the compositor from source and an input mp4 for each frame size.
const COMPOSITOR = join(WORK, "cico");
sh(`swiftc -O "${join(HERE, "..", "main.swift")}" -o "${COMPOSITOR}"`);
function inputFor(w: number, h: number): string {
  const p = join(WORK, `in-${w}x${h}.mp4`);
  sh(`${FF} -y -loglevel error -f lavfi -i testsrc2=size=${w}x${h}:rate=30 -t 1 -pix_fmt yuv420p -c:v libx264 "${p}"`);
  return p;
}

type Case = {
  name: string;
  W: number;
  H: number;
  region: RedactionRegion;
  // constant zoom (ramp 0) as the compositor's ZOOM_SEGMENTS wants it, or null
  zoom: { scale: number; cxf: number; cyf: number } | null;
};

const cases: Case[] = [
  { name: "1x-noZoom", W: 1512, H: 982,
    region: { x: 0.1, y: 0.4379, w: 0.18, h: 0.0163, start: 0, end: 5 }, zoom: null },
  { name: "1x-zoom2-onRegion", W: 1512, H: 982,
    region: { x: 0.1, y: 0.4379, w: 0.18, h: 0.0163, start: 0, end: 5 },
    zoom: { scale: 2.0, cxf: 0.19, cyf: 0.446 } },
  { name: "1x-zoom2-offCenter-clipped", W: 1512, H: 982,
    region: { x: 0.05, y: 0.2, w: 0.2, h: 0.1, start: 0, end: 5 },
    zoom: { scale: 2.0, cxf: 0.7, cyf: 0.5 } },
  { name: "2x-frame-zoom2", W: 3024, H: 1964,
    region: { x: 0.4, y: 0.4, w: 0.15, h: 0.05, start: 0, end: 5 },
    zoom: { scale: 2.2, cxf: 0.45, cyf: 0.42 } },
];

for (const c of cases) {
  const input = inputFor(c.W, c.H);
  const redactPath = join(WORK, `r-${c.name}.json`);
  writeFileSync(redactPath, JSON.stringify([c.region]));
  const env: NodeJS.ProcessEnv = { ...process.env, REDACT_REGIONS: redactPath, REDACT_DEBUG: "on" };
  if (c.zoom) {
    const zp = join(WORK, `z-${c.name}.json`);
    writeFileSync(zp, JSON.stringify([{ start: 0, end: 5, scale: c.zoom.scale, ramp: 0, cxf: c.zoom.cxf, cyf: c.zoom.cyf }]));
    env.ZOOM_SEGMENTS = zp;
  }
  const out = join(WORK, `o-${c.name}.mp4`);
  const res = spawnSync(COMPOSITOR, [input, out], { env, encoding: "utf8" });
  const line = (res.stderr || "").split("\n").find((l) => l.startsWith("REDACT "));

  // TS expectation (top-left px); null = region clipped to nothing under the zoom.
  const zoomSample = c.zoom
    ? { scale: c.zoom.scale, center_x: c.zoom.cxf * c.W, center_y: c.zoom.cyf * c.H }
    : null;
  const tsRect = sourceRectToOutputRect(c.region, zoomSample, c.W, c.H);

  // Off-screen agreement: the compositor emits no REDACT line when it clips a region
  // to empty. TS must agree (also null). Either side alone being empty is a mismatch.
  if (!line) {
    if (tsRect === null) { console.log(`PASS ${c.name}: both clip to nothing (off-screen under zoom)`); }
    else { console.log(`FAIL ${c.name}: TS visible ${JSON.stringify(tsRect)} but compositor clipped it away`); failures++; }
    continue;
  }
  if (tsRect === null) { console.log(`FAIL ${c.name}: compositor drew a region but TS clipped it away`); failures++; continue; }
  // "REDACT t=.. region=minX,minY WxH radius=.." — minX/minY are CI BOTTOM-LEFT px.
  const m = line.match(/region=([\d.]+),([\d.]+) ([\d.]+)x([\d.]+) radius=([\d.]+)/);
  if (!m) { console.log(`FAIL ${c.name}: unparseable: ${line}`); failures++; continue; }
  const [sMinX, sMinY, sW, sH, sRad] = m.slice(1).map(Number);

  const tsMinX = tsRect.x;
  const tsMinY = c.H - (tsRect.y + tsRect.h); // top-left -> bottom-left
  const tsRad = redactRadius(tsRect.w, tsRect.h);

  const d = (a: number, b: number) => Math.abs(a - b);
  const TOL = 1.0; // sub-pixel: rounding across the two languages
  const ok = d(tsMinX, sMinX) < TOL && d(tsMinY, sMinY) < TOL && d(tsRect.w, sW) < TOL && d(tsRect.h, sH) < TOL && d(tsRad, sRad) < 0.05;
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(
    `${tag} ${c.name}: swift[x=${sMinX} y=${sMinY} ${sW}x${sH} r=${sRad}] ` +
    `ts[x=${tsMinX.toFixed(1)} y=${tsMinY.toFixed(1)} ${tsRect.w.toFixed(1)}x${tsRect.h.toFixed(1)} r=${tsRad.toFixed(2)}]`,
  );
}

rmSync(WORK, { recursive: true, force: true });
if (failures) { console.log(`\nTRANSFORM PIN: ${failures} MISMATCH(ES)`); process.exit(1); }
console.log("\nTRANSFORM PIN: TS and Swift agree on every case");
