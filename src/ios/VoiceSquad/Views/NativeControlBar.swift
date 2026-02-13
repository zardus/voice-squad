import SwiftUI

struct NativeControlBar: View {
    @Binding var autoRead: Bool
    var isConnected: Bool
    var isRecording: Bool
    var onToggleRecording: () -> Void
    var onSendText: (String) -> Void

    @State private var text = ""

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 10) {
                Toggle(isOn: $autoRead) {
                    Text("Auto-read")
                        .font(.subheadline)
                }
                .toggleStyle(.switch)
                .frame(maxWidth: 160)

                Spacer(minLength: 0)

                MicButton(isRecording: isRecording, isConnected: isConnected) {
                    onToggleRecording()
                }

                TextField("Type a command...", text: $text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.send)
                    .onSubmit { send() }

                Button("Send") { send() }
                    .buttonStyle(.borderedProminent)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !isConnected)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial)
        }
    }

    private func send() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        onSendText(trimmed)
        text = ""
    }
}

private struct MicButton: View {
    var isRecording: Bool
    var isConnected: Bool
    var onToggle: () -> Void

    var body: some View {
        Button {
            onToggle()
        } label: {
            Image(systemName: isRecording ? "mic.fill" : "mic")
                .font(.system(size: 22, weight: .semibold))
                .frame(width: 42, height: 42)
        }
        .buttonStyle(.bordered)
        .tint(isRecording ? .red : .blue)
        .disabled(!isConnected)
        .accessibilityLabel(isRecording ? "Stop recording" : "Start recording")
    }
}

