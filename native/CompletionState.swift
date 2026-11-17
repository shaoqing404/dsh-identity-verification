import Foundation

enum AuthenticationOutcome: String, Equatable {
    case granted
    case cancelled
    case unavailable
    case timeout
    case error
}

// Mutated only on the main queue. A response received at or after the deadline expires.
struct CompletionState {
    let deadlineNanoseconds: UInt64
    private(set) var finished = false

    mutating func resolve(_ proposed: AuthenticationOutcome, at now: UInt64) -> AuthenticationOutcome? {
        guard !finished else { return nil }
        finished = true
        return now >= deadlineNanoseconds ? .timeout : proposed
    }
}
