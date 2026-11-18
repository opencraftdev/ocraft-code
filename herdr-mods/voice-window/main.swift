// OCraft Voice: the Assistant's voice view (the Ovis web page, ?assistant=voice) in a small native
// window, so herdr-app's Voice button stays out of the browser. WebKit gives the page the microphone
// a herdr-app mod lacks. Open it with: open -a "OCraft Voice" "<voice url>" (one window, reused).
import Cocoa
import WebKit

final class Delegate: NSObject, NSApplicationDelegate, WKUIDelegate, NSWindowDelegate {
    var window: NSWindow!
    var web: WKWebView!

    func applicationDidFinishLaunching(_ note: Notification) {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 680),
                          styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Assistant Voice"
        window.contentView = web
        window.level = .floating
        window.delegate = self
        window.setFrameAutosaveName("OCraftVoice")
        if !window.setFrameUsingName("OCraftVoice") { window.center() }
        if let arg = CommandLine.arguments.dropFirst().first(where: { $0.hasPrefix("http") }) { load(arg) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func application(_ app: NSApplication, open urls: [URL]) {
        if let url = urls.first { load(url.absoluteString) }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func load(_ s: String) {
        guard let url = URL(string: s), url.scheme == "http" || url.scheme == "https" else { return }
        // `vm`: the Assistant VM's address, saved where Ovis keeps it (lib/assistantMode.ts), since this
        // window's storage is its own and Ovis shows Voice only for a pane on the VM it knows
        let controller = web.configuration.userContentController
        controller.removeAllUserScripts()
        if let vm = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "vm" })?.value,
           let data = try? JSONSerialization.data(withJSONObject: [vm]), let json = String(data: data, encoding: .utf8) {
            let js = "try { localStorage.setItem('ovis:assistant-address', \(json)[0]); } catch (e) {}"
            controller.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        web.load(URLRequest(url: url))
    }

    // the page's getUserMedia: granted (the app itself still asks macOS once)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "127.0.0.1" || origin.host == "localhost" ? .grant : .prompt)
    }

    // closing the window ends the call: the app quits
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
