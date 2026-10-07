import Testing
@testable import MitzoShared

@Test func coldSceneForegroundDoesNotReconnectStartedRelay() {
    var lifecycle = SceneForegroundReconnect()
    let first = lifecycle.consumeForegroundReconnect()
    let repeated = lifecycle.consumeForegroundReconnect()
    #expect(!first)
    #expect(!repeated)
}

@Test func eachBackgroundCycleReconnectsOnce() {
    var lifecycle = SceneForegroundReconnect()
    for _ in 0..<3 {
        lifecycle.didEnterBackground()
        let first = lifecycle.consumeForegroundReconnect()
        let repeated = lifecycle.consumeForegroundReconnect()
        #expect(first)
        #expect(!repeated)
    }
}
