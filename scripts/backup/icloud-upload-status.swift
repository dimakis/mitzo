import Foundation

// No contents, paths or native errors are printed. Input is one absolute path
// over stdin; compile this source once and configure the trusted executable.
func probe() -> String {
    guard let input = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8),
          input.utf8.count <= 4096 else { return "unknown" }
    let path = input.trimmingCharacters(in: .newlines)
    guard path.hasPrefix("/"), !path.contains("\0"), !path.contains("\n") else { return "unknown" }
    let url = URL(fileURLWithPath: path)
    do {
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        guard attributes[.type] as? FileAttributeType == .typeRegular else { return "unknown" }
        let values = try url.resourceValues(forKeys: [
            .isUbiquitousItemKey, .ubiquitousItemIsUploadedKey,
            .ubiquitousItemIsUploadingKey, .ubiquitousItemUploadingErrorKey
        ])
        guard values.isUbiquitousItem == true else { return "unknown" }
        if values.ubiquitousItemUploadingError != nil { return "unknown" }
        if values.ubiquitousItemIsUploaded == true && values.ubiquitousItemIsUploading != true { return "uploaded" }
        return "pending"
    } catch { return "unknown" }
}
print("{\"status\":\"\(probe())\"}")
