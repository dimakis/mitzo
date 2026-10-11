import Foundation
import LocalAuthentication
import Darwin

// This executable is invoked only by its original reviewed parent. Never run it
// during compilation/tests; evaluatePolicy presents real system authentication.
let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 7,
      arguments[0] == "authenticate",
      arguments[1] == "--plan-sha256",
      arguments[3] == "--nonce",
      arguments[5] == "--uid",
      arguments[2].range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
      arguments[4].range(of: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", options: .regularExpression) != nil,
      arguments[6].range(of: "^[1-9][0-9]{0,9}$", options: .regularExpression) != nil,
      let requestedUid = UInt32(arguments[6]), requestedUid == getuid(), requestedUid != 0,
      getppid() > 1 else { exit(2) }

let plan = arguments[2]
let nonce = arguments[4]
let parent = getppid()
let context = LAContext()
context.touchIDAuthenticationAllowableReuseDuration = 0
context.localizedCancelTitle = "Cancel"
var availabilityError: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &availabilityError) else { exit(2) }
let reason = "Authorize preserving old native and ordinary staging data and control files, installing fresh isolated ordinary settings with providers off, and one com.mitzo.staging start on mitzo-staging.localhost:3190. Native cleanup stays unconfirmed. Exact combined plan SHA256: \(plan)"
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
    guard success, getppid() == parent else { exit(2) }
    let response: [String: Any] = [
        "version": 1, "result": "authenticated", "planSha256": plan,
        "nonce": nonce, "uid": requestedUid, "parentPid": parent, "helperPid": getpid()
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]),
          data.count <= 1024 else { exit(2) }
    FileHandle.standardOutput.write(data)
    exit(0)
}
dispatchMain()
