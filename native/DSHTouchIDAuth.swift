import AppKit
import Foundation
import LocalAuthentication

private let demoReason = "验证身份以继续演示"

private func writeJSONAndExit(_ value: [String: Any], status: Int32) -> Never {
    // All output values are fixed strings, numbers, booleans, null, or validated identifiers.
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
        FileHandle.standardError.write(Data("Unable to encode helper response\n".utf8))
        exit(2)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
    exit(status)
}

private func nativePolicy(_ policy: AuthenticationPolicy) -> LAPolicy {
    switch policy {
    case .systemOwner: return .deviceOwnerAuthentication
    case .biometricsOnly: return .deviceOwnerAuthenticationWithBiometrics
    }
}

private func freshContext() -> LAContext {
    let context = LAContext()
    context.touchIDAuthenticationAllowableReuseDuration = 0
    return context
}

private func biometryName(_ type: LABiometryType) -> String {
    switch type {
    case .none: return "none"
    case .touchID: return "touch-id"
    case .faceID: return "face-id"
    default:
        if #available(macOS 14.0, *), type == .opticID { return "optic-id" }
        return "unknown"
    }
}

private func probe(_ policy: AuthenticationPolicy) -> (result: [String: Any], type: String) {
    let context = freshContext()
    // Even an accidental evaluation on a probe context cannot show a system prompt.
    context.interactionNotAllowed = true
    var error: NSError?
    let available = context.canEvaluatePolicy(nativePolicy(policy), error: &error)
    let type = biometryName(context.biometryType)
    let reason: Any = available ? NSNull() : classifyAuthenticationError(error).reason as Any
    context.invalidate()
    return (["available": available, "reason": reason], type)
}

private func checkAvailability() -> Never {
    let systemOwner = probe(.systemOwner)
    let biometricsOnly = probe(.biometricsOnly)
    writeJSONAndExit([
        "schemaVersion": helperSchemaVersion,
        "operation": "check",
        "systemOwner": systemOwner.result,
        "biometricsOnly": biometricsOnly.result,
        // This is what the biometric probe reports, not the method of a future authentication.
        "biometryType": biometricsOnly.type,
    ], status: 0)
}

private final class AuthenticationAttempt {
    private let request: AuthenticationRequest
    private let context: LAContext
    private let startedAt: UInt64
    private var completion: CompletionState

    init(request: AuthenticationRequest) {
        self.request = request
        self.context = freshContext()
        self.startedAt = DispatchTime.now().uptimeNanoseconds
        self.completion = CompletionState(
            deadlineNanoseconds: startedAt + UInt64(request.timeoutMilliseconds) * 1_000_000
        )
        self.context.localizedCancelTitle = "取消"
        if request.policy == .biometricsOnly {
            // The biometric-only policy must not offer an application password fallback.
            self.context.localizedFallbackTitle = ""
        }
    }

    private func finish(_ proposed: AuthenticationOutcome, reason proposedReason: String?) {
        dispatchPrecondition(condition: .onQueue(.main))
        let now = DispatchTime.now().uptimeNanoseconds
        guard let outcome = completion.resolve(proposed, at: now) else { return }
        context.invalidate()
        let reason = outcome == .timeout ? "deadline_exceeded" : proposedReason
        writeJSONAndExit(authenticationResponse(
            request: request,
            outcome: outcome,
            reason: reason,
            elapsedMilliseconds: Int((now - startedAt) / 1_000_000)
        ), status: authenticationExitStatus(outcome))
    }

    func start() -> Never {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        application.activate(ignoringOtherApps: true)

        DispatchQueue.main.asyncAfter(deadline: DispatchTime(uptimeNanoseconds: completion.deadlineNanoseconds)) {
            self.finish(.timeout, reason: "deadline_exceeded")
        }
        DispatchQueue.main.async {
            self.context.evaluatePolicy(nativePolicy(self.request.policy), localizedReason: demoReason) { success, error in
                let outcome: AuthenticationOutcome
                let reason: String?
                if success && error == nil {
                    outcome = .granted
                    reason = nil
                } else if success {
                    outcome = .error
                    reason = "unexpected_result"
                } else {
                    let failure = classifyAuthenticationError(error)
                    outcome = failure.outcome
                    reason = failure.reason
                }
                DispatchQueue.main.async { self.finish(outcome, reason: reason) }
            }
        }
        application.run()
        // If AppKit stops unexpectedly, resolve on the same queue as every other outcome.
        DispatchQueue.main.async { self.finish(.error, reason: "application_stopped") }
        dispatchMain()
    }
}

@main
struct DSHTouchIDAuth {
    static func main() {
        do {
            switch try HelperArguments.parse(Array(CommandLine.arguments.dropFirst())) {
            case .check:
                checkAvailability()
            case .authenticate(let request):
                AuthenticationAttempt(request: request).start()
            }
        } catch let failure as ArgumentFailure {
            writeJSONAndExit([
                "schemaVersion": helperSchemaVersion,
                "operation": "invalid",
                "outcome": "error",
                "reason": failure.rawValue,
                "method": "unknown",
            ], status: 2)
        } catch {
            writeJSONAndExit([
                "schemaVersion": helperSchemaVersion,
                "operation": "invalid",
                "outcome": "error",
                "reason": "invalid_command",
                "method": "unknown",
            ], status: 2)
        }
    }
}
