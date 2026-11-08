import Foundation
import Testing
@testable import MitzoShared

@Test func sourcePreviewNullsSurviveTheActualWatchPropertyListBoundary() throws {
    let packet = ReviewValue.object(["attribution": .object(["seatId": .null, "provenance": .null]),
        "context": .object(["messages": .array([.object(["source": .null])])])])
    let payload = try WatchSourceRelayJSON.payload(data: JSONEncoder().encode(packet))
    #expect(PropertyListSerialization.propertyList(payload, isValidFor: .binary))
    let wire = try PropertyListSerialization.data(fromPropertyList: payload, format: .binary, options: 0)
    let received = try #require(PropertyListSerialization.propertyList(from: wire, options: [], format: nil) as? [String: Any])
    #expect(try WatchSourceRelayJSON.decode(received, as: ReviewValue.self) == packet)
    #expect(throws: (any Error).self) { try WatchSourceRelayJSON.payload(data: Data(repeating: 0, count: 55000)) }
    #expect(throws: (any Error).self) { try WatchSourceRelayJSON.decode(["_json": Data([0])], as: ReviewValue.self) }
}
