import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

struct VoiceSquadLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VoiceSquadAttributes.self) { context in
            // Lock screen / banner presentation
            HStack(spacing: 12) {
                Circle()
                    .fill(context.state.isConnected ? .green : .red)
                    .frame(width: 10, height: 10)

                VStack(alignment: .leading, spacing: 4) {
                    Text("VoiceSquad")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                    Text(context.state.latestSpeechText)
                        .font(.subheadline)
                        .lineLimit(3)
                }

                Spacer(minLength: 0)

                Button(intent: ToggleAutoReadIntent()) {
                    Image(systemName: context.state.autoReadEnabled
                          ? "speaker.wave.2.fill" : "speaker.slash.fill")
                        .foregroundStyle(context.state.autoReadEnabled ? .green : .secondary)
                }
            }
            .padding()
            .activityBackgroundTint(.black.opacity(0.8))
            .activitySystemActionForegroundColor(.white)

        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(context.state.isConnected ? .green : .red)
                            .frame(width: 8, height: 8)
                        Text("VoiceSquad")
                            .font(.caption)
                            .fontWeight(.semibold)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Button(intent: ToggleAutoReadIntent()) {
                        Image(systemName: context.state.autoReadEnabled
                              ? "speaker.wave.2.fill" : "speaker.slash.fill")
                            .foregroundStyle(context.state.autoReadEnabled ? .green : .secondary)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.state.latestSpeechText)
                        .font(.caption)
                        .lineLimit(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                Image(systemName: "waveform")
                    .foregroundStyle(context.state.isConnected ? .green : .red)
            } compactTrailing: {
                Text("VS")
                    .font(.caption2)
                    .fontWeight(.bold)
            } minimal: {
                Image(systemName: "waveform")
                    .foregroundStyle(context.state.isConnected ? .green : .red)
            }
        }
    }
}
