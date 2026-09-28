// Agent City wallpaper host: pins a click-through WKWebView at desktop level on every screen.
import Cocoa
import WebKit

let baseURL = ProcessInfo.processInfo.environment["AGENT_CITY_URL"] ?? "http://127.0.0.1:8777/"
let mainOnly = CommandLine.arguments.contains("--main-only")

final class WallpaperWindow: NSWindow, WKNavigationDelegate {
    let web: WKWebView
    var url: URL

    init(screen: NSScreen, url: URL) {
        self.url = url
        let cfg = WKWebViewConfiguration()
        cfg.suppressesIncrementalRendering = true
        web = WKWebView(frame: .zero, configuration: cfg)
        super.init(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
        setFrame(screen.frame, display: false)
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) + 1)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
        ignoresMouseEvents = true
        isOpaque = true
        hasShadow = false
        backgroundColor = NSColor(red: 0.02, green: 0.01, blue: 0.05, alpha: 1)
        isReleasedWhenClosed = false
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        contentView = web
        load()
        orderFrontRegardless()
    }

    func load() { web.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)) }

    // collector not up yet (login race) -> keep retrying
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.load() }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.load() }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { load() }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var windows: [WallpaperWindow] = []
    var status: NSStatusItem!
    var demo = false

    func applicationDidFinishLaunching(_ n: Notification) {
        rebuild()
        NotificationCenter.default.addObserver(self, selector: #selector(rebuild),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(reload),
                                                          name: NSWorkspace.didWakeNotification, object: nil)
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.title = "⌬"
        let menu = NSMenu()
        menu.addItem(withTitle: "Agent City", action: nil, keyEquivalent: "").isEnabled = false
        menu.addItem(.separator())
        menu.addItem(withTitle: "Demo Mode", action: #selector(toggleDemo(_:)), keyEquivalent: "d").target = self
        menu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r").target = self
        menu.addItem(withTitle: "Open in Browser", action: #selector(openBrowser), keyEquivalent: "o").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Agent City", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        status.menu = menu
    }

    func pageURL(for screen: NSScreen) -> URL {
        var c = URLComponents(string: baseURL)!
        var q = c.queryItems ?? []
        // keep the HUD clear of the Dock on the screen that has it
        let dockGap = screen.visibleFrame.minY - screen.frame.minY
        q.append(URLQueryItem(name: "pad", value: String(Int(max(34, dockGap + 26)))))
        if demo { q.append(URLQueryItem(name: "demo", value: "1")) }
        c.queryItems = q
        return c.url!
    }

    @objc func rebuild() {
        windows.forEach { $0.close() }
        let screens = mainOnly ? [NSScreen.main].compactMap { $0 } : NSScreen.screens
        windows = screens.map { WallpaperWindow(screen: $0, url: pageURL(for: $0)) }
    }

    @objc func reload() {
        for (w, s) in zip(windows, mainOnly ? [NSScreen.main].compactMap { $0 } : NSScreen.screens) {
            w.url = pageURL(for: s); w.load()
        }
    }

    @objc func toggleDemo(_ item: NSMenuItem) {
        demo.toggle(); item.state = demo ? .on : .off; reload()
    }

    @objc func openBrowser() { NSWorkspace.shared.open(URL(string: baseURL)!) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
