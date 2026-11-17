import Foundation

let helperSchemaVersion = 1

func authenticationResponse(
    request: AuthenticationRequest,
    outcome: AuthenticationOutcome,
    reason: String?,
    elapsedMilliseconds: Int
) -> [String: Any] {
    let encodedReason: Any = reason.map { $0 as Any } ?? NSNull()
    return [
        "schemaVersion": helperSchemaVersion,
        "operation": "authenticate",
        "requestId": request.requestID,
        "actionId": request.actionID,
        "policy": request.policy.rawValue,
        "outcome": outcome.rawValue,
        "reason": encodedReason,
        "method": "unknown",
        "elapsedMs": elapsedMilliseconds,
    ]
}

func authenticationExitStatus(_ outcome: AuthenticationOutcome) -> Int32 {
    outcome == .granted ? 0 : 1
}
