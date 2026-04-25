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
                DisplayInfo(id: $0.displayID, name: "Display \($0.displayID)", width: Int($0.width), height: Int($0.height))
            }
            let mics = AVCaptureDevice.DiscoverySession(
                deviceTypes: [.microphone, .external],
                mediaType: .audio,
                position: .unspecified
            ).devices.map { MicInfo(uid: $0.uniqueID, name: $0.localizedName) }
            emit(.enumerated(displays: displays, microphones: mics))
        } catch {
            emit(.error(code: "INTERNAL", message: "enumerate failed: \(error)"))
        }
    }

    private func handleStart(_ cmd: Command) async {
        guard state == .idle else {
            emit(.error(code: "INVALID_STATE", message: "already recording"))
            return
        }
        guard let displayID = cmd.display_id, let outputPath = cmd.output_path else {
            emit(.error(code: "INVALID_COMMAND", message: "start requires display_id and output_path"))
            return
        }
        do {
            let newSession = try await RecordingSession(
                displayID: displayID,
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
