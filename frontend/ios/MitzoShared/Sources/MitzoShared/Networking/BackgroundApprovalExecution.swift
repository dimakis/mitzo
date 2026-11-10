import Foundation

/// Bounds the OS callback independently of cooperative network cancellation.
/// A task group would wait for a cancellation-resistant child on scope exit.
public final class BackgroundApprovalExecution: @unchecked Sendable {
    private let lock = NSLock()
    private let timeout: TimeInterval
    private let completion: @Sendable (Result<Void, Error>) -> Void
    private var finished = false
    private var started = false
    private var tasks: [Task<Void, Never>] = []
    public init(timeout: TimeInterval = 12, completion: @escaping @Sendable (Result<Void, Error>) -> Void) {
        self.timeout = timeout; self.completion = completion
    }
    public func start(_ operation: @escaping @Sendable () async throws -> Void) {
        guard lock.withLock({ if started || finished { return false }; started = true; return true }) else { return }
        let work = Task {
            do { try Task.checkCancellation(); try await operation(); self.finish(.success(())) }
            catch { self.finish(.failure(error)) }
        }
        let deadline = Task {
            do { try await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000)) }
            catch { return }
            self.finish(.failure(BackgroundApprovalFailure(code: "approval_deadline")))
        }
        let cancel = lock.withLock { () -> Bool in
            if finished { return true }
            tasks = [work, deadline]; return false
        }
        if cancel { work.cancel(); deadline.cancel() }
    }
    public func cancel() { finish(.failure(BackgroundApprovalFailure(code: "approval_cancelled"))) }
    private func finish(_ result: Result<Void, Error>) {
        let retired = lock.withLock { () -> [Task<Void, Never>]? in
            guard !finished else { return nil }
            finished = true
            let retired = tasks; tasks = []
            return retired
        }
        guard let retired else { return }
        retired.forEach { $0.cancel() }
        completion(result)
    }
}
