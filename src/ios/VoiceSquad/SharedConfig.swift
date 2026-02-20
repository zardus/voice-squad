import Foundation

enum SharedKeys {
    static let suiteName = "group.com.voicesquad.app"
    static let autoReadEnabled = "autoReadEnabled"
    static let lastSpeechText = "lastSpeechText"
}

extension UserDefaults {
    static let shared: UserDefaults = {
        if let defaults = UserDefaults(suiteName: SharedKeys.suiteName) {
            return defaults
        }
        #if DEBUG
        assertionFailure("UserDefaults suite '\(SharedKeys.suiteName)' not found. Check App Group configuration.")
        #endif
        return .standard
    }()

    static func autoReadIsEnabled() -> Bool {
        shared.object(forKey: SharedKeys.autoReadEnabled) == nil
            ? true
            : shared.bool(forKey: SharedKeys.autoReadEnabled)
    }
}
