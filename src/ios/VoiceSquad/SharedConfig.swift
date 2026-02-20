import Foundation

enum SharedKeys {
    static let suiteName = "group.com.voicesquad.app"
    static let autoReadEnabled = "autoReadEnabled"
}

extension UserDefaults {
    static let shared = UserDefaults(suiteName: SharedKeys.suiteName)!

    static func autoReadIsEnabled() -> Bool {
        shared.object(forKey: SharedKeys.autoReadEnabled) == nil
            ? true
            : shared.bool(forKey: SharedKeys.autoReadEnabled)
    }
}
