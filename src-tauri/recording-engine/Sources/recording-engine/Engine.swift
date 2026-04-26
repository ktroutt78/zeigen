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

    // Trim SCK's raw window list down to the set a user would plausibly pick
    // for capture. SCShareableContent returns ~everything: menubar items,
    // tooltips, system overlays, our own helper windows.
    //
    // Filters:
    //  - skip windows owned by Zeigen itself (com.zeigen.app); they show up
    //    because the main window doesn't set sharingType=.none. The tray
    //    icon, bubble, countdown, etc. are excluded automatically by
    //    makeCaptureInvisible.
    //  - require an owning application; system surfaces have none
    //  - require windowLayer == 0 (kCGNormalWindowLevel); higher layers are
    //    menu bars, status items, popups, etc.
    //  - require a reasonable minimum size (100x100); excludes 0-pt phantom
    //    windows the OS keeps around for various reasons
    private func filterShareableWindows(_ windows: [SCWindow]) -> [WindowInfo] {
        windows.compactMap { w -> WindowInfo? in
            guard let app = w.owningApplication else { return nil }
            if app.bundleIdentifier == "com.zeigen.app" { return nil }
            if w.windowLayer != 0 { return nil }
            if w.frame.width < 100 || w.frame.height < 100 { return nil }
            return WindowInfo(
                id: w.windowID,
                app: app.applicationName,
                bundle_id: app.bundleIdentifier,
                title: w.title ?? "",
                x: Int(w.frame.origin.x),
                y: Int(w.frame.origin.y),
                width: Int(w.frame.width),
                height: Int(w.frame.height),
                on_screen: w.isOnScreen
            )
        }
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
