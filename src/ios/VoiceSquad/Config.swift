import Foundation

enum Config {
    static let defaultServerBaseURL = ""
}

final class AppSettings: ObservableObject {
    @Published var serverBaseURL: String
    @Published var token: String

    init() {
        let defaults = UserDefaults.standard
        self.serverBaseURL = defaults.string(forKey: "serverBaseURL") ?? Config.defaultServerBaseURL
        self.token = defaults.string(forKey: "token") ?? ""
    }

    func persist() {
        let defaults = UserDefaults.standard
        defaults.set(serverBaseURL, forKey: "serverBaseURL")
        defaults.set(token, forKey: "token")
    }

    func makeWebURL() -> URL? {
        let base = serverBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var comps = URLComponents(string: base) else { return nil }
        if comps.path.isEmpty { comps.path = "/" }
        var items = comps.queryItems ?? []
        items.removeAll { ["token", "nativeApp"].contains($0.name) }
        items.append(URLQueryItem(name: "token", value: token))
        items.append(URLQueryItem(name: "nativeApp", value: "1"))
        comps.queryItems = items
        return comps.url
    }

    func makeWebSocketURL() -> URL? {
        let base = serverBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var comps = URLComponents(string: base) else { return nil }

        if comps.scheme == "https" { comps.scheme = "wss" }
        else { comps.scheme = "ws" }

        if comps.path.isEmpty { comps.path = "/" }
        var items = comps.queryItems ?? []
        items.removeAll { ["token", "tts"].contains($0.name) }
        items.append(URLQueryItem(name: "token", value: token))
        items.append(URLQueryItem(name: "tts", value: "mp3"))
        comps.queryItems = items
        return comps.url
    }
}
