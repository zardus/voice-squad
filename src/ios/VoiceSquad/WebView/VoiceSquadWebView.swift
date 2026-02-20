import SwiftUI
import UIKit
import WebKit

struct VoiceSquadWebView: UIViewRepresentable {
    let url: URL?
    let webViewID: UUID
    @Binding var autoReadEnabled: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(autoReadEnabled: $autoReadEnabled)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let controller = config.userContentController
        controller.add(context.coordinator, name: "autoReadChanged")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        context.coordinator.webView = webView

        if let url {
            webView.load(URLRequest(url: url))
        }

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.webViewID = webViewID
        if context.coordinator.lastSentAutoReadEnabled != autoReadEnabled {
            context.coordinator.syncAutoReadToPWA(autoReadEnabled)
            context.coordinator.lastSentAutoReadEnabled = autoReadEnabled
        }
        guard let url else { return }
        if uiView.url != url {
            uiView.load(URLRequest(url: url))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var webViewID: UUID = UUID()
        weak var webView: WKWebView?
        var autoReadEnabled: Binding<Bool>
        var lastSentAutoReadEnabled: Bool?
        private var defaultsObserver: NSObjectProtocol?
        private var foregroundObserver: NSObjectProtocol?

        init(autoReadEnabled: Binding<Bool>) {
            self.autoReadEnabled = autoReadEnabled
            super.init()
            defaultsObserver = NotificationCenter.default.addObserver(
                forName: UserDefaults.didChangeNotification,
                object: UserDefaults.shared,
                queue: .main
            ) { [weak self] _ in
                self?.syncAutoReadFromDefaults()
            }
            foregroundObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.willEnterForegroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.syncAutoReadFromDefaults()
            }
        }

        deinit {
            if let defaultsObserver {
                NotificationCenter.default.removeObserver(defaultsObserver)
            }
            if let foregroundObserver {
                NotificationCenter.default.removeObserver(foregroundObserver)
            }
        }

        func syncAutoReadToPWA(_ enabled: Bool) {
            let js = """
            if (typeof window.setAutoRead === 'function') {
                window.setAutoRead(\(enabled));
            } else if (typeof window.setAutoReadEnabled === 'function') {
                window.setAutoReadEnabled(\(enabled), { notifyNative: false });
            }
            """
            webView?.evaluateJavaScript(js) { _, _ in }
        }

        func syncAutoReadFromDefaults() {
            let enabled = UserDefaults.autoReadIsEnabled()
            if autoReadEnabled.wrappedValue != enabled {
                autoReadEnabled.wrappedValue = enabled
            }
            if lastSentAutoReadEnabled != enabled {
                syncAutoReadToPWA(enabled)
                lastSentAutoReadEnabled = enabled
            }
        }

        // WKScriptMessageHandler — PWA notifies native of auto-read changes
        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "autoReadChanged",
                  let enabled = message.body as? Bool else { return }
            Task { @MainActor in
                self.autoReadEnabled.wrappedValue = enabled
                UserDefaults.shared.set(enabled, forKey: SharedKeys.autoReadEnabled)
                await LiveActivityManager.syncAutoReadForAllActivities()
                self.lastSentAutoReadEnabled = enabled
            }
        }

        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(.grant)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            syncAutoReadFromDefaults()
        }
    }
}
