// Redaction test harness (scratch, not shipped).
//   gen  <out.png> <W> <H> <fontpx> <text> [dark]   -> render text, print "BBOX x y w h" (top-left px)
//   solid <out.png> <W> <H> <rrggbb>                -> solid color png (watermark)
//   circle <out.png> <diameter> <padding> <mask|shadow>
//   measure <video.mp4> <fx> <fy> <fw> <fh>         -> print mean squared luma gradient over region
import Foundation
import CoreGraphics
import ImageIO
import CoreText
import AVFoundation
import UniformTypeIdentifiers

func die(_ m: String) -> Never { FileHandle.standardError.write((m+"\n").data(using:.utf8)!); exit(1) }

func rgbaContext(_ w: Int, _ h: Int) -> CGContext {
    let cs = CGColorSpaceCreateDeviceRGB()
    return CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w*4,
        space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

func savePNG(_ img: CGImage, _ path: String) {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)
        else { die("dest") }
    CGImageDestinationAddImage(dest, img, nil)
    guard CGImageDestinationFinalize(dest) else { die("finalize") }
}

// Read a CGImage into a flat RGBA8 buffer (top-left origin row 0).
func pixels(_ img: CGImage) -> (w: Int, h: Int, buf: [UInt8]) {
    let w = img.width, h = img.height
    let ctx = rgbaContext(w, h)
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    let data = ctx.data!
    let p = data.bindMemory(to: UInt8.self, capacity: w*h*4)
    return (w, h, Array(UnsafeBufferPointer(start: p, count: w*h*4)))
}

func cmd_gen(_ a: [String]) {
    guard a.count >= 6 else { die("gen out W H fontpx text [dark]") }
    let out = a[1], W = Int(a[2])!, H = Int(a[3])!, font = Double(a[4])!, text = a[5]
    let dark = a.count >= 7 && a[6] == "dark"
    let ctx = rgbaContext(W, H)
    let bg: CGFloat = dark ? 0.12 : 1.0
    ctx.setFillColor(red: bg, green: bg, blue: bg, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    let fg: CGFloat = dark ? 0.92 : 0.0
    let ctFont = CTFontCreateWithName("Helvetica" as CFString, font, nil)
    let attrs: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): ctFont,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String):
            CGColor(red: fg, green: fg, blue: fg, alpha: 1)]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
    let x0 = Double(W) * 0.10
    let yBaseline = Double(H) - Double(H) * 0.45   // CG bottom-left origin
    ctx.textPosition = CGPoint(x: x0, y: yBaseline)
    CTLineDraw(line, ctx)
    let img = ctx.makeImage()!
    savePNG(img, out)
    // Tight ink bbox: scan for pixels differing from bg (top-left origin output).
    let (w, h, buf) = pixels(img)
    let bgByte = Int(bg * 255)
    var minX = w, minY = h, maxX = 0, maxY = 0, found = false
    for y in 0..<h {
        for x in 0..<w {
            let i = (y*w + x)*4
            if abs(Int(buf[i]) - bgByte) > 40 || abs(Int(buf[i+1]) - bgByte) > 40 {
                found = true
                if x < minX { minX = x }; if x > maxX { maxX = x }
                if y < minY { minY = y }; if y > maxY { maxY = y }
            }
        }
    }
    guard found else { die("no ink drawn") }
    print("BBOX \(minX) \(minY) \(maxX-minX+1) \(maxY-minY+1)")
}

func cmd_solid(_ a: [String]) {
    guard a.count >= 5 else { die("solid out W H rrggbb") }
    let out = a[1], W = Int(a[2])!, H = Int(a[3])!, hex = a[4]
    let n = Int(hex, radix: 16)!
    let r = CGFloat((n>>16)&0xff)/255, g = CGFloat((n>>8)&0xff)/255, b = CGFloat(n&0xff)/255
    let ctx = rgbaContext(W, H)
    ctx.setFillColor(red: r, green: g, blue: b, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    savePNG(ctx.makeImage()!, out)
    print("OK solid")
}

func cmd_circle(_ a: [String]) {
    guard a.count >= 5 else { die("circle out diameter padding mask|shadow") }
    let out = a[1], d = Int(a[2])!, pad = Int(a[3])!, mode = a[4]
    let side = d + 2*pad
    let ctx = rgbaContext(side, side)
    ctx.clear(CGRect(x: 0, y: 0, width: side, height: side))
    let c: CGFloat = mode == "mask" ? 1.0 : 0.0
    ctx.setFillColor(red: c, green: c, blue: c, alpha: 1)
    ctx.fillEllipse(in: CGRect(x: pad, y: pad, width: d, height: d))
    savePNG(ctx.makeImage()!, out)
    print("OK circle \(mode)")
}

func cmd_measure(_ a: [String]) {
    guard a.count >= 6 else { die("measure video fx fy fw fh [alpha tintGray]") }
    let path = a[1]
    let fx = Double(a[2])!, fy = Double(a[3])!, fw = Double(a[4])!, fh = Double(a[5])!
    // Optional overlay-recovery: an attacker who knows the constant tint C (gray in
    // 0..1) and alpha a inverts the source-over composite: B = (out - a*C)/(1-a),
    // per channel, clamped to [0,255]. Measuring gradient of the RECOVERED layer
    // isolates the BLUR — a weak radius leaves text edges that this inversion
    // amplifies by 1/(1-a). Absent -> measure the composited panel as delivered.
    let recover = a.count >= 8
    let rAlpha = recover ? Double(a[6])! : 0.0
    let rTint = recover ? Double(a[7])! * 255.0 : 0.0
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    let gen = AVAssetImageGenerator(asset: asset)
    gen.requestedTimeToleranceBefore = .zero
    gen.requestedTimeToleranceAfter = .zero
    gen.appliesPreferredTrackTransform = true
    let dur = CMTimeGetSeconds(asset.duration)
    let t = CMTime(seconds: max(0.0, dur * 0.5), preferredTimescale: 600)
    guard let cg = try? gen.copyCGImage(at: t, actualTime: nil) else { die("frame decode") }
    let (w, h, buf) = pixels(cg)
    // region in top-left px
    let rx = Int((fx * Double(w)).rounded()), ry = Int((fy * Double(h)).rounded())
    let rw = Int((fw * Double(w)).rounded()), rh = Int((fh * Double(h)).rounded())
    let x0 = max(1, rx), y0 = max(1, ry)
    let x1 = min(w-2, rx+rw), y1 = min(h-2, ry+rh)
    guard x1 > x0 && y1 > y0 else { die("empty region") }
    func rec(_ v: Double) -> Double {
        guard recover else { return v }
        return min(255.0, max(0.0, (v - rAlpha*rTint) / (1.0 - rAlpha)))
    }
    func L(_ x: Int, _ y: Int) -> Double {
        let i = (y*w + x)*4
        return luma(rec(Double(buf[i])), rec(Double(buf[i+1])), rec(Double(buf[i+2])))
    }
    var sum = 0.0; var n = 0
    for y in y0...y1 {
        for x in x0...x1 {
            let gx = L(x+1,y) - L(x-1,y)
            let gy = L(x,y+1) - L(x,y-1)
            sum += gx*gx + gy*gy
            n += 1
        }
    }
    let energy = sum / Double(n)
    print(String(format: "%.4f", energy))
}

func luma(_ r: Double,_ g: Double,_ b: Double)->Double { 0.299*r+0.587*g+0.114*b }

let args = CommandLine.arguments
guard args.count >= 2 else { die("subcommand: gen|solid|circle|measure") }
switch args[1] {
case "gen": cmd_gen(Array(args.dropFirst()))
case "solid": cmd_solid(Array(args.dropFirst()))
case "circle": cmd_circle(Array(args.dropFirst()))
case "measure": cmd_measure(Array(args.dropFirst()))
default: die("unknown subcommand \(args[1])")
}
