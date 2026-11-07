import Foundation
import Testing
@testable import MitzoShared

private func sourcePage(sequences: [Int], scope: String = "scope", changed: Bool = false) throws -> WatchSourceReview {
    let object: [String: Any] = ["permId": "p", "sessionId": "s", "toolUseId": "tool", "proposalSha256": "proposal", "materialScopeSha256": scope,
        "expiresAt": 9999999999999, "operation": ["kind": "adopt", "itemId": "work"],
        "messages": sequences.map { ["messageId": "m\($0)", "sequence": $0, "author": "operator", "blocks": [["content": changed ? "changed" : "message \($0)"]]] as [String: Any] },
        "artifacts": [["artifactId": "file", "revision": 100, "sha256": "hash100", "title": "Report", "filename": "report.md"]],
        "artifactCursor": ["createdAt": "2026-11-07", "artifactId": "file", "revision": 100, "scopeSha256": scope],
        "artifactsHasMore": true, "hasMore": true, "earlierCursor": sequences.min() ?? 0]
    return try JSONDecoder().decode(WatchSourceReview.self, from: JSONSerialization.data(withJSONObject: object))
}

@Test func watchSourceKeepsSelectedExchangeAcrossPagesAndDeduplicatesOverlap() throws {
    let latest = try sourcePage(sequences: [50, 51])
    let earlier = try sourcePage(sequences: [49, 50])
    let combined = try latest.mergingEarlier(earlier)
    let input = try combined.selection(messageIDs: ["m49", "m51"], artifactIDs: [])
    #expect(combined.messages.map(\.id) == ["m49", "m50", "m51"])
    #expect(input.selection.messageIds == ["m49", "m51"])
    #expect(input.selection.boundary.messageId == "m51")
    #expect(try combined.mergingLatest(latest).selection(messageIDs: ["m49", "m51"], artifactIDs: []).selection.messageIds == ["m49", "m51"])
    #expect(throws: (any Error).self) { try latest.mergingEarlier(sourcePage(sequences: [49], scope: "other")) }
    #expect(throws: (any Error).self) { try latest.mergingEarlier(sourcePage(sequences: [49, 50], changed: true)) }
}

@Test func watchSourceSelectsMaterialAfterTheFirstHundredVersions() throws {
    let review = try sourcePage(sequences: [50])
    let input = try #require(review.nextMaterialsInput)
    let object: [String: Any] = ["permId": "p", "sessionId": "s", "toolUseId": "tool", "proposalSha256": "proposal", "materialScopeSha256": "scope",
        "artifacts": [["artifactId": "file", "revision": 150, "sha256": "hash150", "title": "Report", "filename": "report.md"]], "cursor": NSNull(), "hasMore": false]
    let page = try JSONDecoder().decode(WatchSourceMaterialsPage.self, from: JSONSerialization.data(withJSONObject: object))
    let combined = try review.mergingMaterials(page, input: input)
    let selection = try combined.selection(messageIDs: ["m50"], artifactIDs: ["file:100", "file:150"])
    #expect(selection.selection.artifacts.map(\.revision) == [100, 150])
    #expect(combined.nextMaterialsInput == nil)
    #expect(throws: (any Error).self) { try combined.mergingMaterials(page, input: input) }
    #expect(throws: (any Error).self) { try sourcePage(sequences: [50], scope: "changed").mergingMaterials(page, input: input) }
}
