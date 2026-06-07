import Foundation

// MARK: Commands

struct Command: Decodable {
    let command: String
    let display_id: UInt32?
    let window_id: UInt32?
    let microphone_uid: String?
    let output_path: String?
    let max_fps: Int?
    // Phase 9 area capture. When all four are present alongside display_id
    // (and no window_id), the engine captures a sub-region of the display.
    // Units: logical points relative to the display's top-left origin.
    let area_x: Double?
    let area_y: Double?
    let area_width: Double?
    let area_height: Double?
}

// MARK: Events

struct DisplayInfo: Encodable {
    let id: UInt32
    let name: String
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

struct MicInfo: Encodable {
    let uid: String
    let name: String
}

struct WindowInfo: Encodable {
    let id: UInt32
    let app: String
    let bundle_id: String?
    let title: String
    let x: Int
    let y: Int
    let width: Int
    let height: Int
    let on_screen: Bool
}

enum Event {
    case ready(version: String)
    case enumerated(displays: [DisplayInfo], microphones: [MicInfo], windows: [WindowInfo])
    case started(started_at: String)
    case progress(frames: Int, dropped: Int, elapsed_s: Double)
    case paused(elapsed_s: Double)
    case resumed(elapsed_s: Double)
    case stopped(output_path: String, duration_s: Double, bytes: Int64, frames: Int, dropped: Int)
    case window_frame(x: Int, y: Int, width: Int, height: Int, on_screen: Bool)
    // Phase 15 #4 fix: emitted exactly once per recording, when SCK
    // delivers the first sample buffer for the screen stream. Rust uses
    // the receive timestamp to anchor bubble_position_log entries to
    // screen.mp4 PTS=0 (which corresponds to this first frame) instead
    // of the earlier engine_start invocation time. `stream` is currently
    // always "screen"; the field future-proofs against a similar fix
    // for the webcam stream if WEBCAM_LEAD_MS is ever retired.
    case first_frame(stream: String)
    case error(code: String, message: String)
}

func emit(_ event: Event) {
    let json: [String: Any]
    switch event {
    case .ready(let version):
        json = ["event": "ready", "version": version]
    case .enumerated(let displays, let microphones, let windows):
        json = [
            "event": "enumerated",
            "displays": displays.map { ["id": $0.id, "name": $0.name, "x": $0.x, "y": $0.y, "width": $0.width, "height": $0.height] },
            "microphones": microphones.map { ["uid": $0.uid, "name": $0.name] },
            "windows": windows.map { w -> [String: Any] in
                var dict: [String: Any] = [
                    "id": w.id,
                    "app": w.app,
                    "title": w.title,
                    "x": w.x,
                    "y": w.y,
                    "width": w.width,
                    "height": w.height,
                    "on_screen": w.on_screen,
                ]
                if let b = w.bundle_id { dict["bundle_id"] = b }
                return dict
            },
        ]
    case .started(let started_at):
        json = ["event": "started", "started_at": started_at]
    case .progress(let frames, let dropped, let elapsed_s):
        json = ["event": "progress", "frames": frames, "dropped": dropped, "elapsed_s": elapsed_s]
    case .paused(let elapsed_s):
        json = ["event": "paused", "elapsed_s": elapsed_s]
    case .resumed(let elapsed_s):
        json = ["event": "resumed", "elapsed_s": elapsed_s]
    case .stopped(let output_path, let duration_s, let bytes, let frames, let dropped):
        json = [
            "event": "stopped", "output_path": output_path, "duration_s": duration_s,
            "bytes": bytes, "frames": frames, "dropped": dropped,
        ]
    case .window_frame(let x, let y, let width, let height, let on_screen):
        json = ["event": "window_frame", "x": x, "y": y, "width": width, "height": height, "on_screen": on_screen]
    case .first_frame(let stream):
        json = ["event": "first_frame", "stream": stream]
    case .error(let code, let message):
        json = ["event": "error", "code": code, "message": message]
    }
    guard let data = try? JSONSerialization.data(withJSONObject: json, options: []) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

func logStderr(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8) ?? Data())
}
