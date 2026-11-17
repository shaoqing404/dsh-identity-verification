import Foundation

enum AuthenticationPolicy: String, Equatable {
    case systemOwner = "system-owner"
    case biometricsOnly = "biometrics-only"
}

struct AuthenticationRequest: Equatable {
    let requestID: String
    let actionID: String
    let policy: AuthenticationPolicy
    let timeoutMilliseconds: Int
}

enum HelperCommand: Equatable {
    case check
    case authenticate(AuthenticationRequest)
}

enum ArgumentFailure: String, Error {
    case invalidCommand = "invalid_command"
    case unknownArgument = "unknown_argument"
    case duplicateArgument = "duplicate_argument"
    case missingValue = "missing_value"
    case missingArgument = "missing_argument"
    case invalidRequestID = "invalid_request_id"
    case invalidActionID = "invalid_action_id"
    case invalidPolicy = "invalid_policy"
    case invalidTimeout = "invalid_timeout"
}

enum HelperArguments {
    static let actionID = "demo_verify"
    static let minimumTimeoutMilliseconds = 5_000
    static let maximumTimeoutMilliseconds = 120_000

    private static let allowedArguments: Set<String> = [
        "--request-id", "--action-id", "--policy", "--timeout-ms",
    ]

    static func parse(_ arguments: [String]) throws -> HelperCommand {
        guard !arguments.isEmpty else { throw ArgumentFailure.invalidCommand }
        if arguments[0] == "--check" {
            guard arguments.count == 1 else { throw ArgumentFailure.invalidCommand }
            return .check
        }

        var options: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let name = arguments[index]
            guard allowedArguments.contains(name) else { throw ArgumentFailure.unknownArgument }
            guard options[name] == nil else { throw ArgumentFailure.duplicateArgument }
            guard index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") else {
                throw ArgumentFailure.missingValue
            }
            options[name] = arguments[index + 1]
            index += 2
        }
        guard Set(options.keys) == allowedArguments,
              let requestID = options["--request-id"],
              let actionID = options["--action-id"],
              let policyText = options["--policy"],
              let timeoutText = options["--timeout-ms"] else {
            throw ArgumentFailure.missingArgument
        }

        // Restrict identifiers to short printable ASCII, without echoing invalid input.
        let requestBytes = Array(requestID.utf8)
        guard (1...128).contains(requestBytes.count), requestBytes.allSatisfy({ byte in
            (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) ||
            (byte >= 48 && byte <= 57) || [45, 46, 58, 95].contains(byte)
        }) else { throw ArgumentFailure.invalidRequestID }
        guard actionID == Self.actionID else { throw ArgumentFailure.invalidActionID }
        guard let policy = AuthenticationPolicy(rawValue: policyText) else {
            throw ArgumentFailure.invalidPolicy
        }
        let timeoutBytes = Array(timeoutText.utf8)
        guard (1...6).contains(timeoutBytes.count), timeoutBytes.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              timeoutBytes.first != 48, let timeout = Int(timeoutText),
              (minimumTimeoutMilliseconds...maximumTimeoutMilliseconds).contains(timeout) else {
            throw ArgumentFailure.invalidTimeout
        }
        return .authenticate(AuthenticationRequest(
            requestID: requestID,
            actionID: actionID,
            policy: policy,
            timeoutMilliseconds: timeout
        ))
    }
}
