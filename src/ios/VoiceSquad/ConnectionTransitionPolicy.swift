import Foundation

enum AppRuntimeState: Equatable {
    case active
    case inactive
    case background
}

struct ConnectionTransitionPolicy {
    static let activeDisconnectGrace: TimeInterval = 2
    static let inactiveDisconnectGrace: TimeInterval = 12
    static let backgroundDisconnectGrace: TimeInterval = 20

    static func disconnectGrace(for state: AppRuntimeState) -> TimeInterval {
        switch state {
        case .active:
            return activeDisconnectGrace
        case .inactive:
            return inactiveDisconnectGrace
        case .background:
            return backgroundDisconnectGrace
        }
    }

    static func shouldMarkDisconnected(
        disconnectStartedAt: Date,
        now: Date = Date(),
        runtimeState: AppRuntimeState,
        isConnected: Bool
    ) -> Bool {
        guard !isConnected else { return false }
        let elapsed = now.timeIntervalSince(disconnectStartedAt)
        return elapsed >= disconnectGrace(for: runtimeState)
    }
}
