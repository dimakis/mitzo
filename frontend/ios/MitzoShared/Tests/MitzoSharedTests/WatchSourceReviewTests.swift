import Foundation
import Testing
@testable import MitzoShared

@Test func watchSourceSelectionRetainsTheOriginalProposalAndExactExchange() throws {
    let data = """
    {"permId":"p","sessionId":"s","proposalSha256":"proposal","expiresAt":9999999999999,"operation":{"kind":"adopt","itemId":"work","expectedRevision":"rev"},"messages":[{"messageId":"m1","sequence":1,"author":"operator","blocks":[{"content":"Original request"}],"unavailableReason":null},{"messageId":"m2","sequence":2,"author":{"sessionId":"agent"},"blocks":[{"content":"Original reply"}],"unavailableReason":null}],"artifacts":[],"hasMore":false}
    """.data(using: .utf8)!
    let review = try JSONDecoder().decode(WatchSourceReview.self, from: data)
    let input = try review.selection(messageIDs: ["m1", "m2"], artifactIDs: [])
    #expect(input.sessionId == "s")
    #expect(input.proposalSha256 == "proposal")
    #expect(input.selection.boundary.messageId == "m2")
    #expect(input.selection.boundary.sequence == 2)
    #expect(input.selection.messageIds == ["m1", "m2"])
    #expect(throws: (any Error).self) { try review.selection(messageIDs: [], artifactIDs: []) }
    #expect(throws: (any Error).self) { try review.selection(messageIDs: ["missing"], artifactIDs: []) }
    let changed = WatchSourcePreview(permId: "other", sessionId: "s", requestId: input.requestId, proposalSha256: "proposal", preview: .init(sha256: "packet", packet: .null))
    #expect(changed.approval(for: review, input: input) == nil)
    let preview = WatchSourcePreview(permId: "p", sessionId: "s", requestId: input.requestId, proposalSha256: "proposal", preview: .init(sha256: "packet", packet: .null))
    #expect(preview.approval(for: review, input: input)?.previewSha256 == "packet")
}
