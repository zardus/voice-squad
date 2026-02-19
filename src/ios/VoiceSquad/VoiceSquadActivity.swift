import ActivityKit
import Foundation

struct VoiceSquadAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var latestSpeechText: String
        var isConnected: Bool
    }
}
