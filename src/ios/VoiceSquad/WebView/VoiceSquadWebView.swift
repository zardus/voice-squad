import SwiftUI
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

        // Bridge script: intercept PWA setAutoReadEnabled calls and notify native
        let bridgeScript = WKUserScript(source: """
            (function() {
                var _origSetAutoRead = window.setAutoReadEnabled;
                if (typeof _origSetAutoRead === 'function') {
                    window.setAutoReadEnabled = function(enabled, opts) {
                        _origSetAutoRead(enabled, opts);
                        try {
                            window.webkit.messageHandlers.autoReadChanged.postMessage(!!enabled);
                        } catch(e) {}
                    };
                } else {
                    // If setAutoReadEnabled isn't defined yet, observe it
                    var _desc = Object.getOwnPropertyDescriptor(window, 'setAutoReadEnabled');
                    if (!_desc || _desc.configurable) {
                        var _stored;
                        Object.defineProperty(window, 'setAutoReadEnabled', {
                            configurable: true,
                            enumerable: true,
                            get: function() { return _stored; },
                            set: function(fn) {
                                _stored = function(enabled, opts) {
                                    fn(enabled, opts);
                                    try {
                                        window.webkit.messageHandlers.autoReadChanged.postMessage(!!enabled);
                                    } catch(e) {}
                                };
                            }
                        });
                    }
                }
            })();
            """, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        controller.addUserScript(bridgeScript)
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

        init(autoReadEnabled: Binding<Bool>) {
            self.autoReadEnabled = autoReadEnabled
        }

        func syncAutoReadToPWA(_ enabled: Bool) {
            webView?.evaluateJavaScript("if(typeof setAutoReadEnabled==='function')setAutoReadEnabled(\(enabled))") { _, _ in }
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
            let enabled = autoReadEnabled.wrappedValue
            syncAutoReadToPWA(enabled)
            lastSentAutoReadEnabled = enabled
        }
    }
}
