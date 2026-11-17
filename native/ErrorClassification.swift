import Foundation
import LocalAuthentication

struct AuthenticationFailure: Equatable {
    let outcome: AuthenticationOutcome
    let reason: String
}

// Localized framework messages are deliberately not forwarded to callers or logs.
func classifyAuthenticationError(_ error: Error?) -> AuthenticationFailure {
    guard let error = error as NSError? else {
        return AuthenticationFailure(outcome: .error, reason: "no_result")
    }
    guard error.domain == LAError.errorDomain else {
        return AuthenticationFailure(outcome: .error, reason: "framework_error")
    }
    switch LAError.Code(rawValue: error.code) {
    case .userCancel: return AuthenticationFailure(outcome: .cancelled, reason: "user_cancel")
    case .systemCancel: return AuthenticationFailure(outcome: .cancelled, reason: "system_cancel")
    case .appCancel: return AuthenticationFailure(outcome: .cancelled, reason: "app_cancel")
    case .userFallback: return AuthenticationFailure(outcome: .cancelled, reason: "user_fallback")
    case .biometryNotAvailable: return AuthenticationFailure(outcome: .unavailable, reason: "biometry_unavailable")
    case .biometryNotEnrolled: return AuthenticationFailure(outcome: .unavailable, reason: "biometry_not_enrolled")
    case .biometryLockout: return AuthenticationFailure(outcome: .unavailable, reason: "biometry_lockout")
    case .biometryNotPaired: return AuthenticationFailure(outcome: .unavailable, reason: "biometry_not_paired")
    case .biometryDisconnected: return AuthenticationFailure(outcome: .unavailable, reason: "biometry_disconnected")
    case .passcodeNotSet: return AuthenticationFailure(outcome: .unavailable, reason: "passcode_not_set")
    case .notInteractive: return AuthenticationFailure(outcome: .unavailable, reason: "interaction_unavailable")
    case .authenticationFailed: return AuthenticationFailure(outcome: .error, reason: "authentication_failed")
    case .invalidContext: return AuthenticationFailure(outcome: .error, reason: "invalid_context")
    default: return AuthenticationFailure(outcome: .error, reason: "framework_error")
    }
}
