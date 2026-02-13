import SwiftUI
import WebKit

struct VoiceSquadWebView: UIViewRepresentable {
    let url: URL?
    let webViewID: UUID

    @EnvironmentObject private var settings: AppSettings

    func makeCoordinator() -> Coordinator {
        Coordinator(settings: settings)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let contentController = WKUserContentController()
        contentController.add(context.coordinator, name: "voiceSquad")

        // Hide the web bottom bar (#controls) so the native bar can own that space.
        let css = """
        #controls { display: none !important; }
        body { padding-bottom: env(safe-area-inset-bottom) !important; }
        """
        let hideControlsScript = WKUserScript(
            source: "var s=document.createElement('style');s.innerHTML=\(css.jsStringLiteral);document.head.appendChild(s);",
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )

        // Disable web TTS playback to avoid double-audio; the native shell plays TTS.
        // The web UI still renders summaries/history and remains usable for inspection.
        let disableWebTts = WKUserScript(
            source: """
            (function() {
              function patch() {
                try {
                  if (typeof window.playAudio === 'function') {
                    window.playAudio = function(_) {};
                  }
                  if (typeof window.stopTtsPlayback === 'function') {
                    window.stopTtsPlayback = function() {};
                  }
                } catch (e) {}
              }
              if (document.readyState === 'complete' || document.readyState === 'interactive') patch();
              else document.addEventListener('DOMContentLoaded', patch);
              setTimeout(patch, 250);
              setTimeout(patch, 1000);
            })();
            """,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )

        // Observe auto-read checkbox changes and summary text changes.
        let observers = WKUserScript(
            source: """
            (function() {
              try {
                function post(msg) { try { webkit.messageHandlers.voiceSquad.postMessage(msg); } catch (e) {} }

                function wireAutoread() {
                  var cb = document.getElementById('autoread-cb');
                  if (!cb) return;
                  cb.addEventListener('change', function() {
                    try { post({ type: 'autoread_changed', value: !!cb.checked }); } catch (e) {}
                  });
                }

                function wireSummary() {
                  var el = document.getElementById('summary');
                  if (!el) return;
                  var last = '';
                  var obs = new MutationObserver(function() {
                    var txt = (el.textContent || '').trim();
                    if (!txt || txt === last) return;
                    last = txt;
                    post({ type: 'summary_changed', text: txt });
                  });
                  obs.observe(el, { childList: true, subtree: true, characterData: true });
                }

                wireAutoread();
                wireSummary();
                setTimeout(wireAutoread, 500);
                setTimeout(wireSummary, 500);
              } catch (e) {}
            })();
            """,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )

        contentController.addUserScript(hideControlsScript)
        contentController.addUserScript(disableWebTts)
        contentController.addUserScript(observers)
        config.userContentController = contentController

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator

        let bridge = WebBridge()
        bridge.webView = webView
        settings.webBridge = bridge

        if let url {
            webView.load(URLRequest(url: url))
        }

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // When webViewID changes, force a reload with the latest URL.
        context.coordinator.webViewID = webViewID
        guard let url else { return }
        if uiView.url != url {
            uiView.load(URLRequest(url: url))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        private let settings: AppSettings
        var webViewID: UUID = UUID()

        init(settings: AppSettings) {
            self.settings = settings
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "voiceSquad" else { return }
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "autoread_changed":
                if let value = body["value"] as? Bool {
                    DispatchQueue.main.async {
                        self.settings.autoRead = value
                        self.settings.persist()
                    }
                }
            case "summary_changed":
                // Currently informational only; could be used for native notifications later.
                break
            default:
                break
            }
        }
    }
}

private extension String {
    // Minimal JS string literal escaping for embedding CSS.
    var jsStringLiteral: String {
        let escaped = self
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "\"\(escaped)\""
    }
}

