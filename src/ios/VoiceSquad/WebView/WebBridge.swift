import Foundation
import WebKit

final class WebBridge: NSObject {
    weak var webView: WKWebView?

    func setAutoread(_ enabled: Bool) {
        let js = """
        (function() {
          try {
            localStorage.setItem('autoread', \(enabled ? "true" : "false"));
            var cb = document.getElementById('autoread-cb');
            if (cb) {
              cb.checked = \(enabled ? "true" : "false");
              cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } catch (e) {}
        })();
        """
        webView?.evaluateJavaScript(js)
    }
}

