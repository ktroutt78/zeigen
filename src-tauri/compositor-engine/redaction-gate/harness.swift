// Redaction legibility harness (scratch/gate tooling, not shipped).
//   scene  <out.png> <W> <H> <light|dark>   -> render a representative dashboard
//          (large bold KPI numbers + small labels/values, on a light or dark card);
//          prints one "ITEM <id> <x> <y> <w> <h> <text>" line per text element
//          (tight ink bbox, top-left px) so the gate can redact + probe each.
//   ocr    <video.mp4> <fx> <fy> <fw> <fh>   -> Vision OCR of the region in the
//          exported frame, raw and 3x-upscaled; prints "OCR <text>" per line.
//   struct <control.mp4> <treated.mp4> <fx> <fy> <fw> <fh> [rows] -> low-frequency
//          structural correlation of the region between the sharp control export and
//          the redacted export. Downsamples both to `rows` (default 24) of legibility-
//          critical resolution, z-normalizes (so tint/contrast don't matter — only
//          SHAPE), and prints "CORR <pearson>". High = the glyph shape survived the
//          blur = still legible. This is the backstop gradient energy could not be.
import Foundation
import CoreGraphics
import ImageIO
import CoreText
import AVFoundation
import Vision
import UniformTypeIdentifiers

func die(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(1) }
func luma(_ r: Double, _ g: Double, _ b: Double) -> Double { 0.299 * r + 0.587 * g + 0.114 * b }

func rgbaContext(_ w: Int, _ h: Int) -> CGContext {
    let cs = CGColorSpaceCreateDeviceRGB()
    return CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
        space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

func savePNG(_ img: CGImage, _ path: String) {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else { die("dest") }
    CGImageDestinationAddImage(dest, img, nil)
    guard CGImageDestinationFinalize(dest) else { die("finalize") }
}

func pixels(_ img: CGImage) -> (w: Int, h: Int, buf: [UInt8]) {
    let w = img.width, h = img.height
    let ctx = rgbaContext(w, h)
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    let p = ctx.data!.bindMemory(to: UInt8.self, capacity: w * h * 4)
    return (w, h, Array(UnsafeBufferPointer(start: p, count: w * h * 4)))
}

// Mid frame of a video as a CGImage (exact, no tolerance).
func midFrame(_ path: String) -> CGImage {
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    let gen = AVAssetImageGenerator(asset: asset)
    gen.requestedTimeToleranceBefore = .zero
    gen.requestedTimeToleranceAfter = .zero
    gen.appliesPreferredTrackTransform = true
    let dur = CMTimeGetSeconds(asset.duration)
    let t = CMTime(seconds: max(0.0, dur * 0.5), preferredTimescale: 600)
    guard let cg = try? gen.copyCGImage(at: t, actualTime: nil) else { die("frame decode \(path)") }
    return cg
}

func cropCG(_ img: CGImage, _ fx: Double, _ fy: Double, _ fw: Double, _ fh: Double) -> CGImage {
    let w = Double(img.width), h = Double(img.height)
    let r = CGRect(x: (fx * w).rounded(), y: (fy * h).rounded(),
                   width: max(1, (fw * w).rounded()), height: max(1, (fh * h).rounded()))
    guard let c = img.cropping(to: r) else { die("crop") }
    return c
}

// --- scene: representative dashboard corpus ---
struct Item { let id: String; let text: String; let bold: Bool; let size: Double; let xf: Double; let basef: Double }

// The corpus deliberately spans the failing spectrum: large bold display numbers
// (shape lives in low frequency — the gradient gate's blind spot), medium bold, and
// small regular labels/values. `text` may be overridden for decoys (same layout).
func sceneItems(_ W: Int) -> [Item] {
    let s = Double(W) / 1512.0
    return [
        Item(id: "label",   text: "SAFE TO SPEND NOW",        bold: false, size: 22 * s, xf: 0.08, basef: 0.20),
        Item(id: "big",     text: "$849",                     bold: true,  size: 96 * s, xf: 0.08, basef: 0.36),
        Item(id: "medkpi",  text: "$1,284.57",                bold: true,  size: 52 * s, xf: 0.58, basef: 0.34),
        Item(id: "balance", text: "Balance today  $2,109.44", bold: false, size: 26 * s, xf: 0.08, basef: 0.58),
        Item(id: "caption", text: "Account ending 4471",      bold: false, size: 16 * s, xf: 0.08, basef: 0.68),
    ]
}
func drawItem(_ it: Item, text: String, into: CGContext, W: Int, H: Int, color: CGFloat, alpha: CGFloat) {
    let font = CTFontCreateWithName((it.bold ? "Helvetica-Bold" : "Helvetica") as CFString, it.size, nil)
    let attrs: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String):
            CGColor(red: color, green: color, blue: color, alpha: alpha),
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
    into.textPosition = CGPoint(x: it.xf * Double(W), y: Double(H) - it.basef * Double(H))
    CTLineDraw(line, into)
}
// Ink bbox of an item's text drawn alone on a cleared canvas (top-left px).
func inkBBox(_ it: Item, text: String, W: Int, H: Int) -> (Int, Int, Int, Int) {
    let scratch = rgbaContext(W, H)
    scratch.clear(CGRect(x: 0, y: 0, width: W, height: H))
    drawItem(it, text: text, into: scratch, W: W, H: H, color: 1, alpha: 1)
    let sp = scratch.data!.bindMemory(to: UInt8.self, capacity: W * H * 4)
    var minX = W, minY = H, maxX = 0, maxY = 0, found = false
    for y in 0..<H { for x in 0..<W where sp[(y * W + x) * 4 + 3] > 10 {
        found = true
        if x < minX { minX = x }; if x > maxX { maxX = x }
        if y < minY { minY = y }; if y > maxY { maxY = y }
    } }
    guard found else { die("item \(it.id) drew nothing") }
    return (minX, minY, maxX - minX + 1, maxY - minY + 1)
}
func cardFill(_ ctx: CGContext, _ W: Int, _ H: Int, dark: Bool) {
    let bg: CGFloat = dark ? 0.09 : 0.97
    ctx.setFillColor(red: bg, green: bg, blue: bg + (dark ? 0.02 : 0.0), alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
}
func itemColor(_ id: String, dark: Bool) -> CGFloat {
    let fg: CGFloat = dark ? 0.92 : 0.10, muted: CGFloat = dark ? 0.62 : 0.40
    return id == "label" || id == "caption" ? muted : fg
}

func cmd_scene(_ a: [String]) {
    guard a.count >= 5 else { die("scene out W H light|dark") }
    let out = a[1], W = Int(a[2])!, H = Int(a[3])!, dark = a[4] == "dark"
    let ctx = rgbaContext(W, H)
    cardFill(ctx, W, H, dark: dark)
    for it in sceneItems(W) {
        let (x, y, w, h) = inkBBox(it, text: it.text, W: W, H: H)
        print(String(format: "ITEM %@ %d %d %d %d %@", it.id, x, y, w, h, it.text))
        drawItem(it, text: it.text, into: ctx, W: W, H: H, color: itemColor(it.id, dark: dark), alpha: 1)
    }
    savePNG(ctx.makeImage()!, out)
}

// --- renderitem: one dashboard item with a substituted value (for decoys) ---
// Draws item `id` with `text` on the card; prints "BBOX x y w h" (top-left px).
func cmd_renderitem(_ a: [String]) {
    guard a.count >= 7 else { die("renderitem out W H light|dark id text") }
    let out = a[1], W = Int(a[2])!, H = Int(a[3])!, dark = a[4] == "dark", id = a[5]
    let text = a[6...].joined(separator: " ")
    guard let it = sceneItems(W).first(where: { $0.id == id }) else { die("unknown item \(id)") }
    let ctx = rgbaContext(W, H)
    cardFill(ctx, W, H, dark: dark)
    drawItem(it, text: text, into: ctx, W: W, H: H, color: itemColor(id, dark: dark), alpha: 1)
    savePNG(ctx.makeImage()!, out)
    let (x, y, w, h) = inkBBox(it, text: text, W: W, H: H)
    print(String(format: "BBOX %d %d %d %d", x, y, w, h))
}

// --- dist: RMS luma difference of a region between two videos' mid frames ---
func cmd_dist(_ a: [String]) {
    guard a.count >= 7 else { die("dist videoA videoB fx fy fw fh") }
    let fx = Double(a[3])!, fy = Double(a[4])!, fw = Double(a[5])!, fh = Double(a[6])!
    let (_, _, la) = luma2d(cropCG(midFrame(a[1]), fx, fy, fw, fh))
    let (_, _, lb) = luma2d(cropCG(midFrame(a[2]), fx, fy, fw, fh))
    let n = min(la.count, lb.count)
    var s = 0.0
    for i in 0..<n { let d = la[i] - lb[i]; s += d * d }
    print(String(format: "DIST %.5f", (s / Double(max(1, n))).squareRoot()))
}

// --- ocr: Vision text recognition of a region (raw + upscaled) ---
func ocrCG(_ cg: CGImage) -> [String] {
    var found: [String] = []
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([req])
    for obs in (req.results ?? []) {
        if let top = obs.topCandidates(1).first { found.append(top.string) }
    }
    return found
}

func upscale(_ cg: CGImage, _ factor: Int) -> CGImage {
    let w = cg.width * factor, h = cg.height * factor
    let ctx = rgbaContext(w, h)
    ctx.interpolationQuality = .high
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()!
}

func cmd_ocr(_ a: [String]) {
    guard a.count >= 6 else { die("ocr video fx fy fw fh") }
    let cg = cropCG(midFrame(a[1]), Double(a[2])!, Double(a[3])!, Double(a[4])!, Double(a[5])!)
    // An attacker upscales; read both the delivered region and a 3x enlargement.
    for s in ocrCG(cg) { print("OCR \(s)") }
    for s in ocrCG(upscale(cg, 3)) { print("OCR \(s)") }
}

// Hardened OCR: the frost's translucent overlay is invertible, so an attacker (or a
// reader who knows the layout) contrast-stretches to undo it, sharpens, and upscales
// before reading. This models "can it be recovered" far better than raw OCR.
func hardened(_ cg: CGImage) -> CGImage {
    let (w, h, buf) = pixels(cg)
    // Per-channel min/max stretch to full range (undoes the overlay's contrast cut).
    var lo = [255.0, 255.0, 255.0], hi = [0.0, 0.0, 0.0]
    for i in stride(from: 0, to: w*h*4, by: 4) {
        for c in 0..<3 { let v = Double(buf[i+c]); if v < lo[c] { lo[c] = v }; if v > hi[c] { hi[c] = v } }
    }
    let ctx = rgbaContext(w, h)
    let dst = ctx.data!.bindMemory(to: UInt8.self, capacity: w*h*4)
    for i in stride(from: 0, to: w*h*4, by: 4) {
        for c in 0..<3 {
            let rng = max(1.0, hi[c] - lo[c])
            dst[i+c] = UInt8(min(255, max(0, (Double(buf[i+c]) - lo[c]) / rng * 255)))
        }
        dst[i+3] = 255
    }
    return upscale(ctx.makeImage()!, 4)
}
func cmd_ocr2(_ a: [String]) {
    guard a.count >= 6 else { die("ocr2 video fx fy fw fh") }
    let cg = cropCG(midFrame(a[1]), Double(a[2])!, Double(a[3])!, Double(a[4])!, Double(a[5])!)
    for s in ocrCG(hardened(cg)) { print("OCR \(s)") }
}

// --- struct: low-frequency structural correlation (the real backstop) ---
func downsampleLuma(_ cg: CGImage, cols: Int, rows: Int) -> [Double] {
    let (w, h, buf) = pixels(cg)
    var cells = [Double](repeating: 0, count: cols * rows)
    var counts = [Int](repeating: 0, count: cols * rows)
    for y in 0..<h {
        let ry = min(rows - 1, y * rows / h)
        for x in 0..<w {
            let cx = min(cols - 1, x * cols / w)
            let i = (y * w + x) * 4
            cells[ry * cols + cx] += luma(Double(buf[i]), Double(buf[i + 1]), Double(buf[i + 2]))
            counts[ry * cols + cx] += 1
        }
    }
    for k in 0..<cells.count where counts[k] > 0 { cells[k] /= Double(counts[k]) }
    return cells
}

func pearson(_ a: [Double], _ b: [Double]) -> Double {
    let n = Double(a.count)
    let ma = a.reduce(0, +) / n, mb = b.reduce(0, +) / n
    var num = 0.0, da = 0.0, db = 0.0
    for i in 0..<a.count {
        let xa = a[i] - ma, xb = b[i] - mb
        num += xa * xb; da += xa * xa; db += xb * xb
    }
    if da < 1e-9 || db < 1e-9 { return 0 }
    return num / (da * db).squareRoot()
}

func cmd_struct(_ a: [String]) {
    guard a.count >= 7 else { die("struct control treated fx fy fw fh [rows]") }
    let fx = Double(a[3])!, fy = Double(a[4])!, fw = Double(a[5])!, fh = Double(a[6])!
    let rows = a.count >= 8 ? Int(a[7])! : 24
    let ctrl = cropCG(midFrame(a[1]), fx, fy, fw, fh)
    let treat = cropCG(midFrame(a[2]), fx, fy, fw, fh)
    // Legibility-critical grid: `rows` tall, columns by aspect. Downsampling IS a
    // low-pass to human-acuity scale; z-normalized Pearson then asks "does the
    // coarse SHAPE still match?" — invariant to the frost's tint/contrast (affine).
    let aspect = Double(ctrl.width) / Double(max(1, ctrl.height))
    let cols = max(1, Int((Double(rows) * aspect).rounded()))
    let corr = pearson(downsampleLuma(ctrl, cols: cols, rows: rows),
                       downsampleLuma(treat, cols: cols, rows: rows))
    print(String(format: "CORR %.4f", corr))
}

// --- band: critical-band (mid-frequency) legibility measure ---
// Gaussian blur preserves LOW frequencies, so a low-freq structural check is blind
// to blur strength. Reading lives in a mid band (~2-4 cycles per character). We
// bandpass both regions there (difference of gaussians at ~character-feature scale,
// relative to region height) and report the RETENTION of that band's energy in the
// redacted region vs the sharp control. Redaction blur that erases the critical band
// -> low retention -> illegible. This is the metric that should be radius-monotonic.
func luma2d(_ cg: CGImage) -> (w: Int, h: Int, l: [Double]) {
    let (w, h, buf) = pixels(cg)
    var l = [Double](repeating: 0, count: w * h)
    for i in 0..<(w * h) { l[i] = luma(Double(buf[i*4]), Double(buf[i*4+1]), Double(buf[i*4+2])) }
    return (w, h, l)
}
// Separable box blur (3 passes ≈ gaussian), integer radius r, edge-clamped.
func boxBlur(_ src: [Double], _ w: Int, _ h: Int, _ r: Int) -> [Double] {
    if r < 1 { return src }
    func passH(_ a: [Double]) -> [Double] {
        var o = [Double](repeating: 0, count: w * h)
        for y in 0..<h {
            var acc = 0.0
            for x in -r...r { acc += a[y*w + min(w-1, max(0, x))] }
            for x in 0..<w {
                o[y*w + x] = acc / Double(2*r + 1)
                let add = a[y*w + min(w-1, x + r + 1)]
                let sub = a[y*w + max(0, x - r)]
                acc += add - sub
            }
        }
        return o
    }
    func passV(_ a: [Double]) -> [Double] {
        var o = [Double](repeating: 0, count: w * h)
        for x in 0..<w {
            var acc = 0.0
            for y in -r...r { acc += a[min(h-1, max(0, y))*w + x] }
            for y in 0..<h {
                o[y*w + x] = acc / Double(2*r + 1)
                let add = a[min(h-1, y + r + 1)*w + x]
                let sub = a[max(0, y - r)*w + x]
                acc += add - sub
            }
        }
        return o
    }
    var b = src
    for _ in 0..<3 { b = passV(passH(b)) }
    return b
}
func rms(_ a: [Double]) -> Double { (a.reduce(0) { $0 + $1*$1 } / Double(a.count)).squareRoot() }

func cmd_band(_ a: [String]) {
    guard a.count >= 7 else { die("band control treated fx fy fw fh") }
    let fx = Double(a[3])!, fy = Double(a[4])!, fw = Double(a[5])!, fh = Double(a[6])!
    let (cw, ch, cl) = luma2d(cropCG(midFrame(a[1]), fx, fy, fw, fh))
    let (_, _, tl0) = luma2d(cropCG(midFrame(a[2]), fx, fy, fw, fh))
    let tl = tl0.count == cl.count ? tl0 : Array(tl0.prefix(cl.count)) + Array(repeating: 0, count: max(0, cl.count - tl0.count))
    // Character-feature band, relative to region height: DoG between ~5% and ~15% of H.
    let r1 = max(1, Int((0.05 * Double(ch)).rounded()))
    let r2 = max(r1 + 1, Int((0.15 * Double(ch)).rounded()))
    func band(_ l: [Double]) -> [Double] {
        let b1 = boxBlur(l, cw, ch, r1), b2 = boxBlur(l, cw, ch, r2)
        return zip(b1, b2).map { $0 - $1 }
    }
    let bc = band(cl), bt = band(tl)
    let retain = rms(bc) > 1e-9 ? rms(bt) / rms(bc) : 0
    print(String(format: "BAND retain=%.4f bcorr=%.4f r1=%d r2=%d", retain, pearson(bc, bt), r1, r2))
}

// --- stroke: estimate text stroke width in a region (from the SHARP control) ---
// The mosaic must have cell > stroke width or the glyph survives (cell 16 leaked,
// 24 held). Stroke width ~ 2 * inkArea / inkPerimeter: a stroke of width w and
// length L has area wL and perimeter ~2L, so area/perimeter ~ w/2. Robust, geometric,
// and (unlike OCR) reliable enough to give the cell floor teeth in the gate.
func cmd_stroke(_ a: [String]) {
    guard a.count >= 6 else { die("stroke video fx fy fw fh") }
    let (w, h, l) = luma2d(cropCG(midFrame(a[1]), Double(a[2])!, Double(a[3])!, Double(a[4])!, Double(a[5])!))
    // Binarize: ink = the minority class either side of the midrange luma.
    let lo = l.min() ?? 0, hi = l.max() ?? 255
    let mid = (lo + hi) / 2
    var darkCount = 0
    for v in l where v < mid { darkCount += 1 }
    let inkIsDark = darkCount <= l.count - darkCount
    func ink(_ i: Int) -> Bool { inkIsDark ? l[i] < mid : l[i] >= mid }
    var area = 0, perim = 0
    for y in 0..<h { for x in 0..<w where ink(y*w + x) {
        area += 1
        let edge = x == 0 || y == 0 || x == w-1 || y == h-1
            || !ink(y*w + x-1) || !ink(y*w + x+1) || !ink((y-1)*w + x) || !ink((y+1)*w + x)
        if edge { perim += 1 }
    } }
    let stroke = perim > 0 ? 2.0 * Double(area) / Double(perim) : 0
    print(String(format: "STROKE %.2f area=%d perim=%d", stroke, area, perim))
}

let args = CommandLine.arguments
guard args.count >= 2 else { die("subcommand: scene|ocr|struct|band") }
switch args[1] {
case "scene": cmd_scene(Array(args.dropFirst()))
case "renderitem": cmd_renderitem(Array(args.dropFirst()))
case "dist": cmd_dist(Array(args.dropFirst()))
case "ocr": cmd_ocr(Array(args.dropFirst()))
case "ocr2": cmd_ocr2(Array(args.dropFirst()))
case "struct": cmd_struct(Array(args.dropFirst()))
case "band": cmd_band(Array(args.dropFirst()))
case "stroke": cmd_stroke(Array(args.dropFirst()))
default: die("unknown subcommand \(args[1])")
}
