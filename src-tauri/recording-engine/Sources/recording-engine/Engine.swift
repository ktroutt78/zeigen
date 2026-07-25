import AVFoundation
import CoreGraphics
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
            let (windows, stack) = filterShareableWindows(shareable.windows)
            emit(.enumerated(displays: displays, microphones: mics, windows: windows, stack: stack))
        } catch {
            emit(.error(code: "INTERNAL", message: "enumerate failed: \(error)"))
        }
    }

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
    //  - app name contains "WebView" (Electron/Chromium sub-frames like
    //    "Microsoft Teams WebView" — the real surface is the sibling
    //    without the suffix)
    //
    // Then a dedupe pass: apps occasionally expose multiple SCWindows
    // with identical (app, title) — different windowIDs, but functionally
    // the same surface from the user's POV. Keep the largest; the
    // smaller ones are usually dormant helper windows.
    private func filterShareableWindows(_ windows: [SCWindow]) -> ([WindowInfo], [StackWindow]) {
        // Front-to-back stacking order. SCShareableContent doesn't carry a
        // reliable z-order, but CGWindowListCopyWindowInfo returns on-screen
        // windows front-to-back — map each windowID to its index so the
        // picker can resolve the frontmost window under the cursor.
        let onScreen = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
        ) as? [[String: Any]] ?? []
        var zByID: [UInt32: Int] = [:]
        // Occluder stack: every on-screen layer-0 window in front-to-back
        // order, whether or not it survives the pickable filter below. The
        // picker hit-tests against this so a window we dropped (e.g. a WebView
        // sub-frame or a dedupe duplicate) blocks the highlight instead of
        // falling through to the enumerated window behind it. Menu bar / Dock /
        // Control Center are layer != 0 and excluded — not windows a user picks.
        var stack: [StackWindow] = []
        for (index, entry) in onScreen.enumerated() {
            guard let num = entry[kCGWindowNumber as String] as? UInt32 else { continue }
            zByID[num] = index
            let layer = (entry[kCGWindowLayer as String] as? Int) ?? -1
            if layer != 0 { continue }
            guard let b = entry[kCGWindowBounds as String] as? [String: Any],
                  let x = b["X"] as? Double, let y = b["Y"] as? Double,
                  let w = b["Width"] as? Double, let h = b["Height"] as? Double
            else { continue }
            stack.append(StackWindow(id: num, x: Int(x), y: Int(y), width: Int(w), height: Int(h)))
        }

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
                on_screen: w.isOnScreen,
                z: zByID[w.windowID] ?? Int.max
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
        return (byKey.values.sorted { $0.z < $1.z }, stack)
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
        case let (id?, nil):
            if let ax = cmd.area_x, let ay = cmd.area_y,
               let aw = cmd.area_width, let ah = cmd.area_height {
                source = .area(
                    displayID: id,
                    rect: CGRect(x: ax, y: ay, width: aw, height: ah)
                )
            } else {
                source = .display(id)
            }
        case let (nil, id?): source = .window(id)
        case (nil, nil):
            emit(.error(code: "INVALID_COMMAND", message: "start requires display_id or window_id"))
            return
        case (_?, _?):
            emit(.error(code: "INVALID_COMMAND", message: "start requires exactly one of display_id or window_id"))
            return
        }
        do {
            let onFatal: @Sendable (EngineError) -> Void = { [weak self] err in
                guard let self else { return }
                Task {
                    await self.handleFatalError(err)
                }
            }
            let newSession = try await RecordingSession(
                source: source,
                microphoneUID: cmd.microphone_uid,
                outputPath: outputPath,
                maxFPS: cmd.max_fps ?? 30,
                captureCursor: cmd.capture_cursor ?? true,
                onFatalError: onFatal
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
        // V2.2 D-06: pause is rejected before writer-start fires. The
        // recording is alive (SCStream + AVCaptureSession running) but
        // the muxed timeline hasn't been anchored yet, so there's no
        // gapless resume math to apply.
        guard s.writerStarted else {
            emit(.error(code: "INVALID_STATE", message: "pause not accepted before writer-start"))
            return
        }
        s.pause()
        state = .paused
        emit(.paused(elapsed_s: s.elapsedSeconds))
    }

    // Mid-recording fatal-error path. RecordingSession invokes the
    // onFatalError callback (passed into its init) which hops onto this
    // actor. V2.2 c2 wires MIC_NO_FIRST_SAMPLE through here; c3 will add
    // MIC_SESSION_FAILED via the AVCaptureSession runtime-error observer.
    private func handleFatalError(_ err: EngineError) async {
        guard state != .idle, let s = session else { return }
        await s.tearDownAfterFatalError()
        emit(.error(code: err.code, message: err.message))
        session = nil
        state = .idle
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
            if let path = result.cursorTrackPath, let count = result.cursorSampleCount {
                emit(.cursor_track_written(path: path, sample_count: count))
            }
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

struct EngineError: Error, Sendable {
    let code: String
    let message: String
}

struct RecordingResult {
    let path: String
    let duration: Double
    let bytes: Int64
    let frames: Int
    let dropped: Int
    // V3 Phase A: set when capture_cursor was on and a telemetry sidecar
    // was written (nil when the flag was off or no video frame landed).
    let cursorTrackPath: String?
    let cursorSampleCount: Int?
}
