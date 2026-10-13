import Foundation

/// A single share operation owns only its temporary directory and original bytes.
public struct SharedFile: Sendable {
    public let url: URL
    private let directory: URL

    public static func prepare(filename: String, base64: String) throws -> SharedFile {
        guard !filename.isEmpty, filename != ".", filename != "..",
              filename.utf8.count <= 255,
              !filename.contains("/"), !filename.contains("\\"),
              !filename.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              base64.utf8.count <= ((32 * 1024 * 1024 + 2) / 3) * 4,
              let bytes = Data(base64Encoded: base64), bytes.count <= 32 * 1024 * 1024 else {
            throw CocoaError(.fileWriteInvalidFileName)
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("mitzo-share-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                               attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent(filename, isDirectory: false)
        do {
            try bytes.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            return SharedFile(url: url, directory: directory)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    public func remove() {
        try? FileManager.default.removeItem(at: directory)
    }
}
