import Foundation
import Testing
@testable import MitzoShared

@Test func sharedFileKeepsOriginalNameAndBinaryBytes() throws {
    let bytes = Data([0, 255, 128, 65])
    let file = try SharedFile.prepare(filename: "Résumé.docx", base64: bytes.base64EncodedString())
    defer { file.remove() }
    #expect(file.url.isFileURL)
    #expect(file.url.lastPathComponent == "Résumé.docx")
    #expect(try Data(contentsOf: file.url) == bytes)
    let second = try SharedFile.prepare(filename: "Résumé.docx", base64: Data().base64EncodedString())
    defer { second.remove() }
    #expect(second.url != file.url)
    #expect(try Data(contentsOf: second.url).isEmpty)
}

@Test func sharedFileRejectsInvalidNamesAndBytes() {
    for name in ["", ".", "..", "../private.pdf", "/tmp/file.pdf", "a\\b.pdf", "bad\nname.pdf", String(repeating: "x", count: 256)] {
        #expect(throws: (any Error).self) { try SharedFile.prepare(filename: name, base64: "AA==") }
    }
    #expect(throws: (any Error).self) { try SharedFile.prepare(filename: "note.md", base64: "invalid!") }
}

@Test func sharedFileRemovesOnlyItsOwnTemporaryDirectory() throws {
    let first = try SharedFile.prepare(filename: "report.pdf", base64: "AA==")
    let second = try SharedFile.prepare(filename: "report.pdf", base64: "AQ==")
    defer { second.remove() }
    first.remove()
    #expect(!FileManager.default.fileExists(atPath: first.url.path))
    #expect(FileManager.default.fileExists(atPath: second.url.path))
}
