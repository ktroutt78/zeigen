import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

actor Engine {
    enum State { case idle, recording, paused }

    private var state: State = .idle
    private var session: RecordingSession?

    func handle(_ cmd: Command) async {
        switch cmd.command {
        case "enumerate": await handleEnumerate()
        case "start":     await handleStart(cmd)
        case "pause":     handlePause()
        case "resume":    handleResume()
        case "stop":      await handleStop()
        case "quit":      exit(0)
        default:
            emit(.error(code: "INVALID_COMMAND", message: "unknown command: \(cmd.command)"))
        }
    }

    private func handleEnumerate() async {
        do {
            let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            let displays = shareable.displays.map {
                DisplayInfo(
                    id: $0.displayID,
                    name: "Display \($0.displayID)",
                    x: Int($0.frame.origin.x),
                    y: Int($0.frame.origin.y),
                    width: Int($0.width),
                    height: Int($0.height)
                )
            }
            let mics = AVCaptureDevice.DiscoverySession(
                deviceTypes: [.microphone, .external],
                mediaType: .audio,
                position: .unspecified
            ).devices.map { MicInfo(uid: $0.uniqueID, name: $0.localizedName) }
            let windows = filterShareableWindows(shareable.windows)
            emit(.enumerated(displays: displays, microphones: mics, windows: windows))
        } catch {
            emit(.error(code: "INTERNAL", message: "enumerate failed: \(error)"))
        }
    }

    // Apple ships hundreds of background processes (Control Center, Siri,
    // News widgets, etc.) that all expose SCWindows. Allowlist the Apple
    // apps a user would plausibly want to capture; everything else under
    // com.apple.* is rejected. Add to this list if a real Apple app is
    // missing — better to undershoot than swamp the picker.
    private static let appleAllowlist: Set<String> = [
        "com.apple.Safari",
        "com.apple.MobileSMS",
        "com.apple.Music",
        "com.apple.iCal",
        "com.apple.Notes",
        "com.apple.mail",
        "com.apple.finder",
        "com.apple.Terminal",
        "com.apple.MobileSlideShow",
        "com.apple.Preview",
        "com.apple.iWork.Pages",
        "com.apple.iWork.Numbers",
        "com.apple.iWork.Keynote",
        "com.apple.systempreferences",
        "com.apple.dt.Xcode",
        "com.apple.QuickTimePlayerX",
        "com.apple.iBooksX",
        "com.apple.AppStore",
        "com.apple.Maps",
        "com.apple.podcasts",
        "com.apple.TV",
        "com.apple.ScriptEditor2",
        "com.apple.Console",
        "com.apple.ActivityMonitor",
        "com.apple.calculator",
        "com.apple.Reminders",
        "com.apple.shortcuts",
        "com.apple.facetime",
        "com.apple.iMovieApp",
        "com.apple.garageband10",
        "com.apple.dictionary",
        "com.apple.freeform",
    ]

    // Trim SCK's raw window list down to the set a user would plausibly pick
    // for capture. SCShareableContent returns ~everything: menubar items,
    // tooltips, system overlays, password-manager autofill helpers,
    // Electron WebView sub-frames, hidden helper windows.
    //
    // Filters (each rejects):
    //  - Owned by Zeigen itself (com.zeigen.app)
    //  - No owning application (system surfaces)
    //  - windowLayer != 0 (menu bars, status items, popups, tooltips)
    //  - < 100x100 (phantom 0-pt windows the OS keeps around)
    //  - !isOnScreen — SCK can't capture content of a window the OS
    //    isn't drawing; recording one would yield blank or stale frames
    //  - com.apple.* and not in the allowlist (system noise)
    //  - app name contains "WebView" (Electron/Chromium sub-frames like
    //    "Microsoft Teams WebView" — the real surface is the sibling
    //    without the suffix)
    //
    // Then a dedupe pass: apps occasionally expose multiple SCWindows
    // with identical (app, title) — different windowIDs, but functionally
    // the same surface from the user's POV. Keep the largest; the
    // smaller ones are usually dormant helper windows.
    private func filterShareableWindows(_ windows: [SCWindow]) -> [WindowInfo] {
        let candidates: [WindowInfo] = windows.compactMap { w -> WindowInfo? in
            guard let app = w.owningApplication else { return nil }
            let bundleID = app.bundleIdentifier
            if bundleID == "com.zeigen.app" { return nil }
            // Dev builds run as a CLI binary outside any .app bundle, so
            // SCK reports bundleIdentifier as "". Catch our own window by
            // name when the bundle is missing.
            if bundleID.isEmpty && app.applicationName.lowercased() == "zeigen" {
                return nil
            }
            if w.windowLayer != 0 { return nil }
            if w.frame.width < 100 || w.frame.height < 100 { return nil }
            if !w.isOnScreen { return nil }
            if bundleID.hasPrefix("com.apple.") && !Self.appleAllowlist.contains(bundleID) {
                return nil
            }
            if app.applicationName.contains("WebView") { return nil }
            return WindowInfo(
                id: w.windowID,
                app: app.applicationName,
                bundle_id: bundleID,
                title: w.title ?? "",
                x: Int(w.frame.origin.x),
                y: Int(w.frame.origin.y),
                width: Int(w.frame.width),
                height: Int(w.frame.height),
                on_screen: w.isOnScreen
            )
        }

        var byKey: [String: WindowInfo] = [:]
        for w in candidates {
            let key = "\(w.bundle_id ?? w.app)|\(w.title)"
            if let existing = byKey[key] {
                if w.width * w.height > existing.width * existing.height {
                    byKey[key] = w
                }
            } else {
                byKey[key] = w
            }
        }
        return Array(byKey.values)
    }

    private func handleStart(_ cmd: Command) async {
        guard state == .idle else {
            emit(.error(code: "INVALID_STATE", message: "already recording"))
            return
        }
        guard let outputPath = cmd.output_path else {
            emit(.error(code: "INVALID_COMMAND", message: "start requires output_path"))
            return
        }
        let source: RecordingSession.Source
        switch (cmd.display_id, cmd.window_id) {
        case let (id?, nil): source = .display(id)
        case let (nil, id?): source = .window(id)
        case (nil, nil):
            emit(.error(code: "INVALID_COMMAND", message: "start requires display_id or window_id"))
            return
        case (_?, _?):
            emit(.error(code: "INVALID_COMMAND", message: "start requires exactly one of display_id or window_id"))
            return
        }
        do {
            let newSession = try await RecordingSession(
                source: source,
                microphoneUID: cmd.microphone_uid,
                outputPath: outputPath,
                maxFPS: cmd.max_fps ?? 30
            )
            try await newSession.start()
            session = newSession
            state = .recording
            let started = ISO8601DateFormatter().string(from: Date())
            emit(.started(started_at: started))
            startProgressTimer()
            if newSession.capturedWindowID != nil {
                startWindowFrameTimer()
            }
        } catch let err as EngineError {
            emit(.error(code: err.code, message: err.message))
        } catch {
            emit(.error(code: "INTERNAL", message: "start failed: \(error)"))
        }
    }

    private func handlePause() {
        guard state == .recording, let s = session else {
            emit(.error(code: "INVALID_STATE", message: "pause requires recording state"))
            return
        }
        s.pause()
        state = .paused
        emit(.paused(elapsed_s: s.elapsedSeconds))
    }

    private func handleResume() {
        guard state == .paused, let s = session else {
            emit(.error(code: "INVALID_STATE", message: "resume requires paused state"))
            return
        }
        s.resume()
        state = .recording
        emit(.resumed(elapsed_s: s.elapsedSeconds))
    }

    private func handleStop() async {
        guard state != .idle, let s = session else {
            emit(.error(code: "INVALID_STATE", message: "stop requires recording or paused state"))
            return
        }
        do {
            let result = try await s.stop()
            emit(.stopped(
                output_path: result.path,
                duration_s: result.duration,
                bytes: result.bytes,
                frames: result.frames,
                dropped: result.dropped
            ))
        } catch {
            emit(.error(code: "WRITER_FAILED", message: "stop failed: \(error)"))
        }
        session = nil
        state = .idle
    }

    private func startProgressTimer() {
        Task { [weak self] in
            while let self, await self.state != .idle {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await self.emitProgressIfRecording()
            }
        }
    }

    private func emitProgressIfRecording() {
        guard state == .recording, let s = session else { return }
        emit(.progress(frames: s.frameCount, dropped: s.droppedCount, elapsed_s: s.elapsedSeconds))
    }

    // 5Hz cadence chosen so the bubble-tracks-window logic in Rust has
    // tight enough samples that a fast window drag doesn't visibly
    // displace the bubble within the captured frame. CGWindowListCopyWindowInfo
    // is a single Mach call (~1ms); 5Hz is well under any meaningful budget.
    // Emits in both .recording and .paused states so the UI can keep its
    // window-frame cache fresh during pause.
    private func startWindowFrameTimer() {
        Task { [weak self] in
            while let self, await self.state != .idle {
                await self.emitWindowFrameIfActive()
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
        }
    }

    private func emitWindowFrameIfActive() {
        guard state != .idle, let s = session, let wid = s.capturedWindowID else { return }
        let opts: CGWindowListOption = [.optionIncludingWindow]
        guard let raw = CGWindowListCopyWindowInfo(opts, wid) as? [[String: Any]],
              let entry = raw.first
        else { return }
        let onScreen = (entry[kCGWindowIsOnscreen as String] as? Bool) ?? false
        guard let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDict)
        else { return }
        emit(.window_frame(
            x: Int(bounds.origin.x),
            y: Int(bounds.origin.y),
            width: Int(bounds.size.width),
            height: Int(bounds.size.height),
            on_screen: onScreen
        ))
    }
}

struct EngineError: Error {
    let code: String
    let message: String
}

struct RecordingResult {
    let path: String
    let duration: Double
    let bytes: Int64
    let frames: Int
    let dropped: Int
}
