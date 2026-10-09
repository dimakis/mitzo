import Foundation
import Security
import CryptoKit
import Darwin

// One bounded JSON request on stdin; credentials never appear in argv or diagnostics.
func reply(_ object: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{\"ok\":false,\"code\":\"unavailable\"}".utf8)
    FileHandle.standardOutput.write(data)
    exit(0)
}
func failed(_ status: OSStatus) -> Never {
    let code: String
    switch status {
    case errSecItemNotFound: code = "item_missing"
    case errSecInteractionNotAllowed, errSecAuthFailed, errSecUserCanceled: code = "unlock_on_mac"
    default: code = "unavailable"
    }
    reply(["ok": false, "code": code])
}
let data = FileHandle.standardInput.readData(ofLength: 65537)
guard data.count <= 65536,
      let input = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let operation = input["operation"] as? String,
      ["save", "link", "read", "remove", "rotation-read", "rotation-write", "rotation-authorize", "rotation-create"].contains(operation),
      let service = input["service"] as? String, !service.isEmpty, service.count <= 256,
      let account = input["account"] as? String, !account.isEmpty, account.count <= 256
else { reply(["ok": false, "code": "invalid_request"]) }

var allowed: Set<String> = ["operation", "service", "account", "secret", "persistentRef", "authorization", "namespace", "version", "expectedVersion"]
#if KEYCHAIN_TESTING
allowed.insert("testKeychain")
allowed.insert("testController")
#endif
guard Set(input.keys).isSubset(of: allowed),
      ["rotation-write", "rotation-create"].contains(operation) || (input["version"] == nil && input["expectedVersion"] == nil),
      ["save", "rotation-write", "rotation-create"].contains(operation) || input["secret"] == nil
else { reply(["ok": false, "code": "invalid_request"]) }
if ["save", "remove"].contains(operation) && !service.hasPrefix("mitzo.connection.") {
    reply(["ok": false, "code": "invalid_request"])
}
let namespace: String
if let requestedNamespace = input["namespace"] {
    guard let value = requestedNamespace as? String else { reply(["ok": false, "code": "invalid_request"]) }
    namespace = value
} else { namespace = "default" }
guard namespace.range(of: "^[a-z][a-z0-9-]{0,63}$", options: .regularExpression) == namespace.startIndex..<namespace.endIndex else {
    reply(["ok": false, "code": "invalid_request"])
}
// Resolve the real OS user's home; a caller cannot redirect controller authentication with HOME.
guard let homePointer = getpwuid(getuid())?.pointee.pw_dir else { reply(["ok": false, "code": "unauthorized"]) }
var controllerPath = String(cString: homePointer) + "/.mitzo/keychain-helper/" + namespace + "/controller.json"
#if KEYCHAIN_TESTING
guard let fixtureController = input["testController"] as? String else { reply(["ok": false, "code": "unauthorized"]) }
controllerPath = fixtureController
#endif
var fileInfo = stat()
var directoryInfo = stat()
let controllerDirectory = (controllerPath as NSString).deletingLastPathComponent
guard lstat(controllerPath, &fileInfo) == 0, fileInfo.st_uid == getuid(), fileInfo.st_mode & 0o777 == 0o600, fileInfo.st_mode & S_IFMT == S_IFREG,
      lstat(controllerDirectory, &directoryInfo) == 0, directoryInfo.st_uid == getuid(), directoryInfo.st_mode & 0o777 == 0o700, directoryInfo.st_mode & S_IFMT == S_IFDIR,
      fileInfo.st_size <= 1_048_576,
      let controllerData = try? Data(contentsOf: URL(fileURLWithPath: controllerPath)),
      let controller = (try? JSONSerialization.jsonObject(with: controllerData)) as? [String: Any],
      let expected = controller["authorization"] as? String, expected.count == 64,
      let authorization = input["authorization"] as? String
else { reply(["ok": false, "code": "unauthorized"]) }
let expectedHash = Array(SHA256.hash(data: Data(expected.utf8)))
let actualHash = Array(SHA256.hash(data: Data(authorization.utf8)))
let difference = zip(expectedHash, actualHash).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) }
guard difference == 0 else { reply(["ok": false, "code": "unauthorized"]) }
if operation == "read" || operation == "remove" {
    guard let persistentRef = input["persistentRef"] as? String,
          let items = controller["items"] as? [[String: Any]],
          items.contains(where: { ($0["persistentRef"] as? String) == persistentRef && ($0["service"] as? String) == service && ($0["account"] as? String) == account })
    else { reply(["ok": false, "code": "unauthorized"]) }
}
// OpenAI rotation is restricted to host-configured coordinates in the private controller record.
// Only the browser's separately reauthorized setup action may request native interaction.
if operation.hasPrefix("rotation-") {
    guard !service.contains("\0"), !account.contains("\0"), !service.hasPrefix("mitzo.connection."),
          input["persistentRef"] == nil,
          let rotationItems = controller["rotationItems"] as? [[String: Any]],
          rotationItems.contains(where: { ($0["service"] as? String) == service && ($0["account"] as? String) == account })
    else { reply(["ok": false, "code": "unauthorized"]) }
    SecKeychainSetUserInteractionAllowed(operation == "rotation-authorize")
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service, kSecAttrAccount as String: account]
    #if KEYCHAIN_TESTING
    guard let path = input["testKeychain"] as? String else { reply(["ok": false, "code": "invalid_request"]) }
    var keychain: SecKeychain?
    let opened = SecKeychainOpen(path, &keychain)
    guard opened == errSecSuccess, let keychain else { failed(opened) }
    query[kSecMatchSearchList as String] = [keychain]
    SecKeychainSetUserInteractionAllowed(false)
    #endif
    if operation == "rotation-create" {
        guard input["expectedVersion"] == nil,
              let version = input["version"] as? String, let uuid = UUID(uuidString: version),
              uuid.uuidString.lowercased() == version, service == "mitzo.openai.enrollment." + version,
              account == "api-key", let secret = input["secret"] as? String,
              !secret.isEmpty, secret.utf8.count <= 16384
        else { reply(["ok": false, "code": "invalid_request"]) }
        let value = Data(secret.utf8)
        let fingerprint = SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined()
        var attributes = query
        attributes[kSecValueData as String] = value
        attributes[kSecAttrGeneric as String] = Data(("mitzo-openai-key-v1:" + version + ":" + fingerprint).utf8)
        #if KEYCHAIN_TESTING
        attributes.removeValue(forKey: kSecMatchSearchList as String)
        attributes[kSecUseKeychain as String] = keychain
        #endif
        // The same signed identity creates and later reads this new item. Never overwrite a duplicate.
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { failed(status) }
        reply(["ok": true])
    }
    var metadataQuery = query
    metadataQuery[kSecReturnAttributes as String] = true
    metadataQuery[kSecReturnPersistentRef as String] = true
    metadataQuery[kSecMatchLimit as String] = kSecMatchLimitAll
    var metadata: CFTypeRef?
    let metadataStatus = SecItemCopyMatching(metadataQuery as CFDictionary, &metadata)
    guard metadataStatus == errSecSuccess else { failed(metadataStatus) }
    let matches = (metadata as? [[String: Any]]) ?? []
    guard matches.count == 1, let persistent = matches[0][kSecValuePersistentRef as String] as? Data else {
        reply(["ok": false, "code": "unavailable"])
    }
    var selected: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecValuePersistentRef as String: persistent, kSecReturnAttributes as String: true,
        kSecReturnData as String: true]
    #if KEYCHAIN_TESTING
    selected[kSecMatchSearchList as String] = query[kSecMatchSearchList as String]
    #endif
    var found: CFTypeRef?
    let readStatus = SecItemCopyMatching(selected as CFDictionary, &found)
    guard readStatus == errSecSuccess else { failed(readStatus) }
    guard let item = found as? [String: Any], let value = item[kSecValueData as String] as? Data,
          let secret = String(data: value, encoding: .utf8), !secret.isEmpty, value.count <= 16384
    else { reply(["ok": false, "code": "unavailable"]) }
    let marker = (item[kSecAttrGeneric as String] as? Data) ?? Data()
    let prefix = "mitzo-openai-key-v1:"
    var version: String?
    if !marker.isEmpty {
        guard let text = String(data: marker, encoding: .utf8), text.hasPrefix(prefix) else {
            reply(["ok": false, "code": "unavailable"])
        }
        let parts = text.dropFirst(prefix.count).split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, let id = UUID(uuidString: String(parts[0])),
              id.uuidString.lowercased() == String(parts[0]), parts[1].count == 64,
              parts[1].allSatisfy({ $0.isHexDigit && !$0.isUppercase })
        else { reply(["ok": false, "code": "unavailable"]) }
        let fingerprint = SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined()
        if fingerprint == parts[1] { version = String(parts[0]) }
    }
    if operation == "rotation-authorize" { reply(["ok": true]) }
    if operation == "rotation-read" {
        reply(["ok": true, "value": secret, "version": version as Any? ?? NSNull(), "managed": !marker.isEmpty])
    }
    guard input.keys.contains("expectedVersion"),
          (input["expectedVersion"] is NSNull || input["expectedVersion"] is String),
          (input["expectedVersion"] as? String) == version,
          let replacement = input["secret"] as? String, !replacement.isEmpty, replacement.utf8.count <= 16384,
          let newVersion = input["version"] as? String, let uuid = UUID(uuidString: newVersion),
          uuid.uuidString.lowercased() == newVersion
    else { reply(["ok": false, "code": "invalid_request"]) }
    let replacementData = Data(replacement.utf8)
    let fingerprint = SHA256.hash(data: replacementData).map { String(format: "%02x", $0) }.joined()
    var target: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecValuePersistentRef as String: persistent]
    if !marker.isEmpty { target[kSecAttrGeneric as String] = marker }
    #if KEYCHAIN_TESTING
    target[kSecMatchSearchList as String] = query[kSecMatchSearchList as String]
    #endif
    // Update the existing secret and receipt together; preserve the item's ACL and identity.
    let writeStatus = SecItemUpdate(target as CFDictionary, [kSecValueData as String: replacementData,
        kSecAttrGeneric as String: Data((prefix + newVersion + ":" + fingerprint).utf8)] as CFDictionary)
    guard writeStatus == errSecSuccess else { failed(writeStatus) }
    reply(["ok": true])
}

// Reads in a background session must return an actionable error rather than hang on a desktop prompt.
SecKeychainSetUserInteractionAllowed(operation == "save" || operation == "link")
var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]
#if KEYCHAIN_TESTING
// This input is unavailable in production builds. Tests never search the login keychain.
guard let path = input["testKeychain"] as? String else { reply(["ok": false, "code": "invalid_request"]) }
var keychain: SecKeychain?
let opened = SecKeychainOpen(path, &keychain)
guard opened == errSecSuccess, let keychain else { failed(opened) }
if operation == "save" { query[kSecUseKeychain as String] = keychain }
else { query[kSecMatchSearchList as String] = [keychain] }
SecKeychainSetUserInteractionAllowed(false)
#endif
var expectedCreation: Double?
var expectedGeneration: String?
var expectedSecretMAC: Data?
if let rawReference = input["persistentRef"] {
    guard let encoded = rawReference as? String else { reply(["ok": false, "code": "invalid_request"]) }
    guard let encodedPin = Data(base64Encoded: encoded), encodedPin.count <= 2048,
          let pin = (try? JSONSerialization.jsonObject(with: encodedPin)) as? [String: Any],
          (pin["version"] as? Int) == 1,
          let raw = pin["reference"] as? String,
          let ref = Data(base64Encoded: raw), !ref.isEmpty,
          let creation = pin["creation"] as? Double,
          let generation = pin["generation"] as? String,
          let encodedMAC = pin["secretMAC"] as? String,
          let secretMAC = Data(base64Encoded: encodedMAC), secretMAC.count == 32
    else { reply(["ok": false, "code": "invalid_request"]) }
    expectedCreation = creation
    expectedGeneration = generation
    expectedSecretMAC = secretMAC
    query.removeValue(forKey: kSecAttrService as String)
    query.removeValue(forKey: kSecAttrAccount as String)
    query[kSecValuePersistentRef as String] = ref
}
if operation == "save" {
    guard input["persistentRef"] == nil,
          let secret = input["secret"] as? String, !secret.isEmpty, secret.utf8.count <= 16384
    else { reply(["ok": false, "code": "invalid_request"]) }
    query[kSecValueData as String] = Data(secret.utf8)
    query[kSecAttrLabel as String] = "Mitzo connection"
    query[kSecAttrGeneric as String] = Data(UUID().uuidString.utf8)
    query[kSecReturnPersistentRef as String] = true
    var result: CFTypeRef?
    // Add only: rotation gets a new item, and cannot overwrite another application's credential.
    let status = SecItemAdd(query as CFDictionary, &result)
    guard status == errSecSuccess, let persistent = result as? Data else { failed(status) }
    query.removeValue(forKey: kSecValueData as String)
    query.removeValue(forKey: kSecAttrLabel as String)
    query.removeValue(forKey: kSecAttrGeneric as String)
    query.removeValue(forKey: kSecReturnPersistentRef as String)
    query[kSecValuePersistentRef as String] = persistent
}
// Match exactly one item. Ambiguous coordinates never select an arbitrary keychain entry.
var metadataQuery = query
metadataQuery[kSecReturnAttributes as String] = true
metadataQuery[kSecReturnPersistentRef as String] = true
metadataQuery[kSecMatchLimit as String] = kSecMatchLimitAll
var metadata: CFTypeRef?
let metadataStatus = SecItemCopyMatching(metadataQuery as CFDictionary, &metadata)
if operation == "remove" && metadataStatus == errSecItemNotFound { reply(["ok": true]) }
guard metadataStatus == errSecSuccess else { failed(metadataStatus) }
let items = (metadata as? [[String: Any]]) ?? ((metadata as? [String: Any]).map { [$0] } ?? [])
guard items.count == 1,
      let persistent = items[0][kSecValuePersistentRef as String] as? Data,
      (items[0][kSecAttrService as String] as? String) == service,
      (items[0][kSecAttrAccount as String] as? String) == account,
      let creation = items[0][kSecAttrCreationDate as String] as? Date
else { reply(["ok": false, "code": "unavailable"]) }
// Legacy Keychain persistent references can be reused for recreated coordinates. Pin the
// creation identity as well; Mitzo-owned items additionally have a random generation marker.
let generation = (items[0][kSecAttrGeneric as String] as? Data)?.base64EncodedString() ?? ""
if let expectedCreation {
    guard expectedCreation == creation.timeIntervalSince1970, expectedGeneration == generation else {
        if operation == "remove" { reply(["ok": true]) }
        reply(["ok": false, "code": "item_missing"])
    }
}
let pinKey = SymmetricKey(data: Data(expected.utf8))
func makePin(_ credential: Data) -> Data? {
    let secretMAC = Data(HMAC<SHA256>.authenticationCode(for: credential, using: pinKey)).base64EncodedString()
    return try? JSONSerialization.data(withJSONObject: ["version": 1, "reference": persistent.base64EncodedString(), "creation": creation.timeIntervalSince1970, "generation": generation, "secretMAC": secretMAC], options: [.sortedKeys])
}
query[kSecValuePersistentRef as String] = persistent
if operation == "remove" {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { failed(status) }
    reply(["ok": true])
}
if operation == "save" {
    guard let secret = input["secret"] as? String, let pin = makePin(Data(secret.utf8)) else { reply(["ok": false, "code": "unavailable"]) }
    reply(["ok": true, "service": service, "account": account, "persistentRef": pin.base64EncodedString()])
}
query[kSecReturnData as String] = true
query[kSecMatchLimit as String] = kSecMatchLimitOne
var result: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &result)
guard status == errSecSuccess, let secretData = result as? Data,
      let secret = String(data: secretData, encoding: .utf8), !secret.isEmpty
else { failed(status) }
if let expectedSecretMAC, !HMAC<SHA256>.isValidAuthenticationCode(expectedSecretMAC, authenticating: secretData, using: pinKey) {
    reply(["ok": false, "code": "item_missing"])
}
if operation == "link" {
    guard let pin = makePin(secretData) else { reply(["ok": false, "code": "unavailable"]) }
    // User may approve the signed helper on the Mac. Return only the pinned item identity.
    reply(["ok": true, "service": service, "account": account, "persistentRef": pin.base64EncodedString()])
}
reply(["ok": true, "secret": secret])
