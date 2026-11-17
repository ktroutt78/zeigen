import AppKit
import CryptoKit

// The image the export draws for a cursor shape, as PNG.
//
// The drawn cursor is scaled by the capture's backing scale, the cursor size
// setting and the zoom: up to about 10x its point size. macOS hands out the
// arrow and I-beam with pixel versions up to 10x, but the older cursors (the
// pointing hand, the grab hands, copy, the resize arrows...) only at 1x and 2x,
// so a 32 pt hand was a 64 px picture stretched to 100-300 px: soft (Keith,
// 2026-11-16). The system keeps vector art for those cursors; when a shape is
// one of them it is drawn from that art at 10x. Anything else (an app's own
// cursor) keeps its largest pixel version.
enum CursorArt {
    static let scale: CGFloat = 10
    private static let artRoot = "/System/Library/Frameworks/ApplicationServices.framework/Versions/A/Frameworks/HIServices.framework/Versions/A/Resources/cursors"

    static func png(image: NSImage, hotSpot: NSPoint, tiff: Data) -> Data? {
        let reps = NSBitmapImageRep.imageReps(with: tiff).compactMap { $0 as? NSBitmapImageRep }
        guard let largest = reps.max(by: { $0.pixelsWide < $1.pixelsWide }) else { return nil }
        // Already as detailed as the art would be: keep exactly what the system drew.
        if CGFloat(largest.pixelsWide) < image.size.width * scale,
           let hash = pixelHash(largest), let name = standardArt[hash],
           let art = vectorPNG(name: name, size: image.size, hotSpot: hotSpot) {
            return art
        }
        return largest.representation(using: .png, properties: [:])
    }

    // Standard cursors by the pixels of their largest version -> art folder name.
    // Matched on pixels, not on which NSCursor an app set: whatever shows this
    // exact picture gets the art.
    private static let standardArt: [SHA256.Digest: String] = {
        var named: [(NSCursor, String)] = [
            (.pointingHand, "pointinghand"), (.openHand, "openhand"), (.closedHand, "closedhand"),
            (.dragCopy, "copy"), (.dragLink, "makealias"), (.contextualMenu, "contextualmenu"),
            (.operationNotAllowed, "notallowed"), (.crosshair, "cross"), (.disappearingItem, "poof"),
            (.resizeLeft, "resizeleft"), (.resizeRight, "resizeright"), (.resizeLeftRight, "resizeleftright"),
            (.resizeUp, "resizeup"), (.resizeDown, "resizedown"), (.resizeUpDown, "resizeupdown"),
        ]
        if #available(macOS 15.0, *) { named += [(.zoomIn, "zoomin"), (.zoomOut, "zoomout")] }
        var map: [SHA256.Digest: String] = [:]
        for (cursor, name) in named {
            guard let tiff = cursor.image.tiffRepresentation,
                  let rep = NSBitmapImageRep.imageReps(with: tiff).compactMap({ $0 as? NSBitmapImageRep })
                      .max(by: { $0.pixelsWide < $1.pixelsWide }),
                  let hash = pixelHash(rep) else { continue }
            map[hash] = name
        }
        return map
    }()

    private static func context(_ w: Int, _ h: Int) -> CGContext? {
        CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    }

    private static func pixelHash(_ rep: NSBitmapImageRep) -> SHA256.Digest? {
        guard let cg = rep.cgImage, let ctx = context(cg.width, cg.height), let data = ctx.data else { return nil }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        return SHA256.hash(data: Data(bytes: data, count: cg.width * cg.height * 4))
    }

    // The art is used only when its canvas and hotspot equal the live cursor's,
    // so it lands exactly where the picture it replaces did. A system that
    // moves or redraws the art just falls back to the pixels.
    private static func vectorPNG(name: String, size: NSSize, hotSpot: NSPoint) -> Data? {
        for dir in ["\(artRoot)/macos27/\(name)", "\(artRoot)/\(name)"] {
            guard let info = NSDictionary(contentsOfFile: dir + "/info.plist"),
                  let hx = (info["hotx"] as? NSNumber)?.doubleValue,
                  let hy = (info["hoty"] as? NSNumber)?.doubleValue,
                  abs(hx - hotSpot.x) < 0.5, abs(hy - hotSpot.y) < 0.5,
                  let doc = CGPDFDocument(URL(fileURLWithPath: dir + "/cursor.pdf") as CFURL),
                  let page = doc.page(at: 1)
            else { continue }
            let box = page.getBoxRect(.mediaBox)
            guard box.size == size,
                  let ctx = context(Int(box.width * scale), Int(box.height * scale)) else { continue }
            if let c = info["shadowcolor"] as? [NSNumber], c.count == 4 {
                let blur = (info["blur"] as? NSNumber)?.doubleValue ?? 0
                let dx = (info["shadowoffsetx"] as? NSNumber)?.doubleValue ?? 0
                let dy = (info["shadowoffsety"] as? NSNumber)?.doubleValue ?? 0
                ctx.setShadow(offset: CGSize(width: dx * scale, height: dy * scale), blur: blur * scale,
                              color: CGColor(srgbRed: c[0].doubleValue, green: c[1].doubleValue,
                                             blue: c[2].doubleValue, alpha: c[3].doubleValue))
            }
            ctx.beginTransparencyLayer(auxiliaryInfo: nil)
            ctx.scaleBy(x: scale, y: scale)
            ctx.drawPDFPage(page)
            ctx.endTransparencyLayer()
            guard let cg = ctx.makeImage() else { continue }
            return NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])
        }
        return nil
    }
}
