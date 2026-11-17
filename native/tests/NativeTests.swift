import Foundation
import LocalAuthentication

private func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
    guard condition() else {
        FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
        exit(1)
    }
}

private func expectFailure(_ arguments: [String], _ expected: ArgumentFailure) {
    do {
        _ = try HelperArguments.parse(arguments)
        expect(false, "expected \(expected.rawValue)")
    } catch let actual as ArgumentFailure {
        expect(actual == expected, "expected \(expected.rawValue), got \(actual.rawValue)")
    } catch {
        expect(false, "unexpected parser error")
    }
}

private func authenticationArguments(
    requestID: String = "Req-0123_ab:C.d",
    actionID: String = "demo_verify",
    policy: String = "system-owner",
    timeout: String = "5000"
) -> [String] {
    ["--request-id", requestID, "--action-id", actionID, "--policy", policy, "--timeout-ms", timeout]
}

private func testArguments() throws {
    let check = try HelperArguments.parse(["--check"])
    expect(check == .check, "check mode")
    let request = try HelperArguments.parse(authenticationArguments())
    expect(request == .authenticate(AuthenticationRequest(
        requestID: "Req-0123_ab:C.d", actionID: "demo_verify", policy: .systemOwner,
        timeoutMilliseconds: 5_000
    )), "exact request binding and lower timeout boundary")
    let maximum = try HelperArguments.parse(authenticationArguments(policy: "biometrics-only", timeout: "120000"))
    expect(maximum == .authenticate(AuthenticationRequest(
        requestID: "Req-0123_ab:C.d", actionID: "demo_verify", policy: .biometricsOnly,
        timeoutMilliseconds: 120_000
    )), "biometric policy and upper timeout boundary")

    expectFailure([], .invalidCommand)
    expectFailure(["--check", "--policy", "system-owner"], .invalidCommand)
    expectFailure(["--bogus", "x"], .unknownArgument)
    expectFailure(["--request-id", "abc", "--request-id", "def"], .duplicateArgument)
    expectFailure(["--request-id"], .missingValue)
    expectFailure(["--request-id", "--action-id"], .missingValue)
    expectFailure(["--request-id", "abc"], .missingArgument)
    expectFailure(authenticationArguments(requestID: ""), .invalidRequestID)
    expectFailure(authenticationArguments(requestID: "space id"), .invalidRequestID)
    expectFailure(authenticationArguments(requestID: "测试"), .invalidRequestID)
    expectFailure(authenticationArguments(requestID: String(repeating: "a", count: 129)), .invalidRequestID)
    expectFailure(authenticationArguments(actionID: "other_action"), .invalidActionID)
    expectFailure(authenticationArguments(policy: "2"), .invalidPolicy)
    expectFailure(authenticationArguments(policy: "SYSTEM-OWNER"), .invalidPolicy)
    for invalid in ["4999", "120001", "0", "05000", "+5000", "5.0", "9999999"] {
        expectFailure(authenticationArguments(timeout: invalid), .invalidTimeout)
    }
}

private func testCompletion() {
    var success = CompletionState(deadlineNanoseconds: 100)
    expect(success.resolve(.granted, at: 99) == .granted, "success before deadline")
    expect(success.resolve(.cancelled, at: 99) == nil, "second completion ignored")

    var atDeadline = CompletionState(deadlineNanoseconds: 100)
    expect(atDeadline.resolve(.granted, at: 100) == .timeout, "deadline overrides late success")
    expect(atDeadline.resolve(.granted, at: 101) == nil, "late callback ignored")

    var timerFirst = CompletionState(deadlineNanoseconds: 100)
    expect(timerFirst.resolve(.timeout, at: 101) == .timeout, "timer completion")
    expect(timerFirst.resolve(.granted, at: 102) == nil, "success after timer ignored")
}

private func testErrorClassification() {
    let cases: [(LAError.Code, AuthenticationOutcome, String)] = [
        (.userCancel, .cancelled, "user_cancel"),
        (.systemCancel, .cancelled, "system_cancel"),
        (.appCancel, .cancelled, "app_cancel"),
        (.userFallback, .cancelled, "user_fallback"),
        (.biometryNotAvailable, .unavailable, "biometry_unavailable"),
        (.biometryNotEnrolled, .unavailable, "biometry_not_enrolled"),
        (.biometryLockout, .unavailable, "biometry_lockout"),
        (.biometryNotPaired, .unavailable, "biometry_not_paired"),
        (.biometryDisconnected, .unavailable, "biometry_disconnected"),
        (.passcodeNotSet, .unavailable, "passcode_not_set"),
        (.notInteractive, .unavailable, "interaction_unavailable"),
        (.authenticationFailed, .error, "authentication_failed"),
        (.invalidContext, .error, "invalid_context"),
    ]
    for (code, outcome, reason) in cases {
        let error = NSError(domain: LAError.errorDomain, code: code.rawValue)
        expect(classifyAuthenticationError(error) == AuthenticationFailure(outcome: outcome, reason: reason), reason)
    }
    expect(classifyAuthenticationError(nil) == AuthenticationFailure(outcome: .error, reason: "no_result"), "no result")
    let alien = NSError(domain: "other", code: LAError.Code.userCancel.rawValue)
    expect(classifyAuthenticationError(alien) == AuthenticationFailure(outcome: .error, reason: "framework_error"), "error domain")
}

private func testResponseBinding() throws {
    let request = AuthenticationRequest(requestID: "Case_sensitive:123", actionID: "demo_verify", policy: .biometricsOnly, timeoutMilliseconds: 5000)
    for outcome in [AuthenticationOutcome.granted, .cancelled, .unavailable, .timeout, .error] {
        let reason: String? = outcome == .granted ? nil : "test_reason"
        let response = authenticationResponse(request: request, outcome: outcome, reason: reason, elapsedMilliseconds: 42)
        let json = try JSONSerialization.data(withJSONObject: response)
        let decoded = try JSONSerialization.jsonObject(with: json) as! [String: Any]
        expect(decoded["schemaVersion"] as? Int == 1, "response schema")
        expect(decoded["operation"] as? String == "authenticate", "response operation")
        expect(decoded["requestId"] as? String == request.requestID, "exact request ID echo")
        expect(decoded["actionId"] as? String == request.actionID, "exact action ID echo")
        expect(decoded["policy"] as? String == request.policy.rawValue, "exact policy echo")
        expect(decoded["outcome"] as? String == outcome.rawValue, "response outcome")
        expect(decoded["method"] as? String == "unknown", "unknown method")
        expect(decoded["elapsedMs"] as? Int == 42, "response elapsed time")
        expect(reason == nil ? decoded["reason"] is NSNull : decoded["reason"] as? String == reason, "response reason")
        expect(authenticationExitStatus(outcome) == (outcome == .granted ? 0 : 1), "response exit status")
    }
}

@main
struct NativeTests {
    static func main() throws {
        try testArguments()
        testCompletion()
        testErrorClassification()
        try testResponseBinding()
        print("Native parser, completion, error mapping, and response binding tests passed; no authentication invoked.")
    }
}
