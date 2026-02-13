import Foundation

enum Config {
    static let defaultServerBaseURL = "http://localhost:3000"
}

final class AppSettings: ObservableObject {
    @Published var serverBaseURL: String
    @Published var token: String
    @Published var autoRead: Bool

    // Set by ContentView once the WebView exists.
    weak var webBridge: WebBridge?

    init() {
        // Keep storage explicit so this app works without extra dependencies.
        let defaults = UserDefaults.standard
        self.serverBaseURL = defaults.string(forKey: "serverBaseURL") ?? Config.defaultServerBaseURL
        self.token = defaults.string(forKey: "token") ?? ""
        self.autoRead = defaults.object(forKey: "autoRead") as? Bool ?? false
    }

    func persist() {
        let defaults = UserDefaults.standard
        defaults.set(serverBaseURL, forKey: "serverBaseURL")
        defaults.set(token, forKey: "token")
        defaults.set(autoRead, forKey: "autoRead")
    }

    func makeWebURL() -> URL? {
        let base = serverBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var comps = URLComponents(string: base) else { return nil }
        // Ensure trailing slash path so `?token=...` is correct even if user enters host only.
        if comps.path.isEmpty { comps.path = "/" }
        var items = comps.queryItems ?? []
        items.removeAll { $0.name == "token" }
        items.append(URLQueryItem(name: "token", value: token))
        comps.queryItems = items
        return comps.url
    }

    func makeWebSocketURL(tts: String = "mp3") -> URL? {
        let base = serverBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var comps = URLComponents(string: base) else { return nil }

        // Convert http(s) base URL into ws(s).
        if comps.scheme == "https" { comps.scheme = "wss" }
        else { comps.scheme = "ws" }

        if comps.path.isEmpty { comps.path = "/" }
        var items = comps.queryItems ?? []
        items.removeAll { ["token", "tts"].contains($0.name) }
        items.append(URLQueryItem(name: "token", value: token))
        items.append(URLQueryItem(name: "tts", value: tts))
        comps.queryItems = items
        return comps.url
    }
}

