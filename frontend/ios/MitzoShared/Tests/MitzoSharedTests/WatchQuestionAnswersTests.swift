import Foundation
import Testing
@testable import MitzoShared

private func questionItem(multi: Bool = false, freeform: Bool = true) throws -> MitzoNotification {
    let object: [String: Any] = ["id": "permission:question", "kind": "question", "title": "Choose", "body": "Watch", "sessionId": "s1", "createdAt": 1,
        "request": ["permId": "question", "toolName": "AskUserQuestion", "toolInput": "", "questions": [["id": "q", "question": "Choose an account", "options": [["label": "Work"], ["label": "Personal"]], "multiSelect": multi, "allowFreeform": freeform]]]]
    return try JSONDecoder().decode(MitzoNotification.self, from: JSONSerialization.data(withJSONObject: object))
}

@Test func watchQuestionsCarryExactChoiceIDsThroughTheResponse() throws {
    let item = try questionItem()
    let answers = ["q": ["Work"]]
    let response = watchNotificationResponse(reviewed: item, current: item, decision: .once, answers: answers)
    #expect(response?.answers == answers)
    let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(response!)) as! [String: Any]
    #expect(object["answers"] as? [String: [String]] == answers)
    #expect(watchNotificationResponse(reviewed: item, current: item, decision: .session, answers: answers) == nil)
    #expect(watchNotificationResponse(reviewed: item, current: item, decision: .once) == nil)
    #expect(watchNotificationResponse(reviewed: item, current: item, decision: .once, answers: ["other": ["Work"]]) == nil)
    #expect(watchNotificationResponse(reviewed: item, current: item, decision: .once, answers: ["q": ["Work", "Personal"]]) == nil)
    #expect(watchNotificationResponse(reviewed: item, current: item, decision: .once, answers: ["q": ["  "]]) == nil)
}

@Test func watchQuestionsRespectMultipleChoiceAndFreeformPolicy() throws {
    let item = try questionItem(multi: true, freeform: false)
    #expect(watchNotificationResponse(reviewed: item, current: item, decision: .once, answers: ["q": ["Work", "Personal"]]) != nil)
    #expect(watchNotificationResponse(reviewed: item, current: item, decision: .once, answers: ["q": ["Unknown"]]) == nil)
    let freeform = try questionItem()
    #expect(watchNotificationResponse(reviewed: freeform, current: freeform, decision: .once, answers: ["q": ["Dictated answer"]]) != nil)
    #expect(watchNotificationResponse(reviewed: freeform, current: item, decision: .once, answers: ["q": ["Work"]]) == nil)
}
