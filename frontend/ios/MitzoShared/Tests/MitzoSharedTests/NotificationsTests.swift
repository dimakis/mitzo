import Foundation
import Testing
@testable import MitzoShared

@Test func notificationReadDoesNotRemoveActionAndExpirationDoes() throws {
    let data = """
    {"id":"permission:p1","kind":"approval","title":"Run tests?","body":"Session","sessionId":"s1","createdAt":1,"expiresAt":1000,"readAt":5,"resolvedAt":null,"resolution":null,"request":{"permId":"p1","toolName":"Bash","toolInput":"npm test"}}
    """.data(using: .utf8)!
    let item = try JSONDecoder().decode(MitzoNotification.self, from: data)
    #expect(item.isActionable(at: 999))
    #expect(!item.isActionable(at: 1000))
    #expect(item.request?.toolInput == "npm test")
}

@Test func notificationResponsesCannotEncodePersistentGrants() throws {
    let response = NotificationResponse(sessionId: "s1", decision: .once)
    let data = try JSONEncoder().encode(response)
    let object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    #expect(object["decision"] as? String == "once")
    #expect(NotificationResponse.Decision(rawValue: "always") == nil)
    #expect(object["sessionId"] as? String == "s1")
}

@Test func notificationQuestionsPreservePromptsAndChoicesForWatchReview() throws {
    let data = """
    {"id":"permission:q1","kind":"question","title":"A session has a question","body":"Session","sessionId":"s1","createdAt":1,"readAt":null,"resolvedAt":null,"resolution":null,"request":{"permId":"q1","toolName":"AskUserQuestion","toolInput":"","questions":[{"id":"scope","question":"Which project should I change?","options":[{"label":"Mitzo","description":"The notification feature"}],"multiSelect":false,"allowFreeform":true}]}}
    """.data(using: .utf8)!
    let item = try JSONDecoder().decode(MitzoNotification.self, from: data)
    #expect(item.request?.questions?.first?.question == "Which project should I change?")
    #expect(item.request?.questions?.first?.options.first?.label == "Mitzo")
    #expect(item.request?.questions?.first?.options.first?.description == "The notification feature")
}
