/// Process launch already starts the relay. Only a foreground transition after
/// background suspension needs another connection attempt.
public struct SceneForegroundReconnect {
    private var suspended = false

    public init() {}

    public mutating func didEnterBackground() {
        suspended = true
    }

    public mutating func consumeForegroundReconnect() -> Bool {
        defer { suspended = false }
        return suspended
    }
}
