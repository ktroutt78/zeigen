import Foundation

let engine = Engine()
emit(.ready(version: "0.1.0"))

while let line = readLine() {
    if line.isEmpty { continue }
    guard let data = line.data(using: .utf8) else {
        emit(.error(code: "INVALID_COMMAND", message: "non-utf8 line"))
        continue
    }
    do {
        let cmd = try JSONDecoder().decode(Command.self, from: data)
        await engine.handle(cmd)
    } catch {
        emit(.error(code: "INVALID_COMMAND", message: "\(error)"))
    }
}
