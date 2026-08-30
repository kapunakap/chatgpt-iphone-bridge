import Combine
import Foundation
import UIKit
import WebKit

@MainActor
final class BrowserController: NSObject, ObservableObject {
  @Published private(set) var currentURL: URL?
  @Published private(set) var isLoading = false
  @Published private(set) var lastError: String?

  let webView: WKWebView
  private let bridgeWorld = WKContentWorld.world(name: "ChatGPTIPhoneBridge")
  private(set) var allowedOrigins: Set<String> = []
  private var allowInternalBlank = false

  override init() {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    configuration.userContentController.addUserScript(
      WKUserScript(
        source: Self.bridgeScript,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: false,
        in: WKContentWorld.world(name: "ChatGPTIPhoneBridge")
      )
    )
    webView = WKWebView(frame: .zero, configuration: configuration)
    super.init()
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = false
    webView.isInspectable = false
  }

  func begin(initialURL: URL, allowedOrigins: [String]) throws {
    self.allowedOrigins = Set(allowedOrigins)
    guard isAllowed(initialURL) else {
      throw BridgeError(code: "ORIGIN_NOT_APPROVED", message: "Initial URL origin was not approved")
    }
    lastError = nil
    webView.load(
      URLRequest(url: initialURL, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30))
  }

  func stop() {
    webView.stopLoading()
    allowedOrigins = []
    allowInternalBlank = true
    webView.loadHTMLString(
      "<html><body style='font-family:-apple-system;padding:24px'>Session stopped.</body></html>",
      baseURL: nil)
  }

  func navigate(action: String, url: URL?) async throws -> JSONValue {
    switch action {
    case "open":
      guard let url, isAllowed(url) else {
        throw BridgeError(code: "ORIGIN_NOT_APPROVED", message: "URL origin was not approved")
      }
      webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30))
    case "back":
      guard webView.canGoBack else {
        throw BridgeError(code: "NAVIGATION_UNAVAILABLE", message: "There is no previous page")
      }
      webView.goBack()
    case "forward":
      guard webView.canGoForward else {
        throw BridgeError(code: "NAVIGATION_UNAVAILABLE", message: "There is no next page")
      }
      webView.goForward()
    case "reload": webView.reload()
    default: throw BridgeError(code: "INVALID_ARGUMENTS", message: "Navigation action is invalid")
    }
    return .object([
      "accepted": .bool(true), "currentUrl": .string((url ?? currentURL)?.absoluteString ?? ""),
    ])
  }

  func find(strategy: String, selector: String, limit: Int) async throws -> JSONValue {
    try await bridgeCommand(
      "find",
      args: [
        "strategy": .string(strategy), "selector": .string(selector),
        "limit": .number(Double(limit)),
      ])
  }

  func element(action: String, elementId: String, text: String?) async throws -> JSONValue {
    var args: [String: JSONValue] = ["action": .string(action), "elementId": .string(elementId)]
    if let text { args["text"] = .string(text) }
    return try await bridgeCommand("element", args: args)
  }

  func snapshot(maxNodes: Int) async throws -> JSONValue {
    let result = try await bridgeCommand("snapshot", args: ["maxNodes": .number(Double(maxNodes))])
    let bytes = try JSONEncoder().encode(result)
    guard bytes.count <= 32 * 1024 else {
      throw BridgeError(code: "RESPONSE_TOO_LARGE", message: "Page snapshot exceeded 32 KiB")
    }
    return result
  }

  func screenshot(maxWidth: Int) async throws -> JSONValue {
    let image = try await webView.takeSnapshot(configuration: nil)
    var width = min(CGFloat(maxWidth), image.size.width)
    var quality: CGFloat = 0.78
    var data: Data?
    var output: UIImage = image
    while width >= 320 {
      let scale = width / image.size.width
      let size = CGSize(width: width, height: max(1, image.size.height * scale))
      let renderer = UIGraphicsImageRenderer(size: size)
      output = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
      quality = 0.78
      while quality >= 0.35 {
        data = output.jpegData(compressionQuality: quality)
        if let data, data.count <= Int(1.5 * 1024 * 1024) { break }
        quality -= 0.1
      }
      if let data, data.count <= Int(1.5 * 1024 * 1024) { break }
      width *= 0.75
    }
    guard let data, data.count <= Int(1.5 * 1024 * 1024) else {
      throw BridgeError(
        code: "RESPONSE_TOO_LARGE", message: "Screenshot could not fit under 1.5 MiB")
    }
    return .object([
      "mimeType": .string("image/jpeg"),
      "data": .string(data.base64EncodedString()),
      "width": .number(Double(output.size.width)),
      "height": .number(Double(output.size.height)),
    ])
  }

  func clearWebsiteData() async throws {
    let store = WKWebsiteDataStore.default()
    let types = WKWebsiteDataStore.allWebsiteDataTypes()
    await withCheckedContinuation { continuation in
      store.removeData(ofTypes: types, modifiedSince: .distantPast) { continuation.resume() }
    }
  }

  private func bridgeCommand(_ command: String, args: [String: JSONValue]) async throws -> JSONValue
  {
    let data = try JSONEncoder().encode(JSONValue.object(args))
    let foundation = try JSONSerialization.jsonObject(with: data)
    let result = try await webView.callAsyncJavaScript(
      "return await globalThis.__chatgptIPhoneBridge(command, args);",
      arguments: ["command": command, "args": foundation],
      in: nil,
      contentWorld: bridgeWorld
    )
    return try JSONValue.from(any: result ?? NSNull())
  }

  private func isAllowed(_ url: URL) -> Bool {
    guard let origin = url.bridgeOrigin else { return false }
    return allowedOrigins.contains(origin)
  }

  private static let bridgeScript = #"""
    (() => {
      const state = { generation: 1, nextId: 1, elements: new Map() };
      const reset = () => { state.generation += 1; state.nextId = 1; state.elements.clear(); };
      const observe = () => {
        if (!document.documentElement) return setTimeout(observe, 0);
        new MutationObserver(reset).observe(document.documentElement, {
          childList: true, subtree: true, attributes: true, characterData: true
        });
      };
      observe();
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const text = (element, limit = 500) => String(element.innerText || element.textContent || '')
        .replace(/\s+/g, ' ').trim().slice(0, limit);
      const implicitRole = (element) => {
        const tag = element.tagName.toLowerCase();
        if (tag === 'a' && element.hasAttribute('href')) return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') {
          const type = String(element.type || 'text').toLowerCase();
          if (['button', 'submit', 'reset'].includes(type)) return 'button';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          return 'textbox';
        }
        return '';
      };
      const accessibleName = (element) => String(
        element.getAttribute('aria-label') || element.getAttribute('title') ||
          (element.labels && Array.from(element.labels).map(label => text(label)).join(' ')) || text(element, 200)
      ).slice(0, 200);
      const register = (element) => {
        for (const [id, existing] of state.elements) if (existing === element) return id;
        const id = `${state.generation}:${state.nextId++}`;
        state.elements.set(id, element);
        return id;
      };
      const describe = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          elementId: register(element), tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || implicitRole(element),
          name: accessibleName(element), text: text(element),
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      };
      const requireElement = (id) => {
        const generation = Number(String(id).split(':')[0]);
        const element = state.elements.get(id);
        if (generation !== state.generation || !element || !element.isConnected) {
          throw new Error('STALE_ELEMENT: Element ID expired after the page changed');
        }
        return element;
      };
      const setValue = (element, value) => {
        if (element.isContentEditable) {
          element.textContent = value;
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(element, value); else element.value = value;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };
      globalThis.__chatgptIPhoneBridge = async (command, args) => {
        if (command === 'find') {
          const limit = Math.max(1, Math.min(20, Number(args.limit || 20)));
          const matches = [];
          if (args.strategy === 'css') {
            for (const element of document.querySelectorAll(String(args.selector))) {
              if (visible(element)) matches.push(element);
              if (matches.length >= limit) break;
            }
          } else {
            const wanted = String(args.selector).trim().toLowerCase();
            for (const element of document.querySelectorAll('*')) {
              if (!visible(element)) continue;
              const matchesText = args.strategy === 'text' && text(element).toLowerCase().includes(wanted);
              const matchesRole = args.strategy === 'role' &&
                String(element.getAttribute('role') || implicitRole(element)).toLowerCase() === wanted;
              if (matchesText || matchesRole) matches.push(element);
              if (matches.length >= limit) break;
            }
          }
          return { generation: state.generation, elements: matches.map(describe) };
        }
        if (command === 'element') {
          const element = requireElement(String(args.elementId));
          if (args.action === 'tap') { element.scrollIntoView({ block: 'center', inline: 'center' }); element.click(); }
          else if (args.action === 'type') { element.focus(); setValue(element, String(args.text || '')); }
          else if (args.action === 'clear') { element.focus(); setValue(element, ''); }
          else if (args.action === 'scrollIntoView') element.scrollIntoView({ block: 'center', inline: 'nearest' });
          else if (args.action === 'getText') return { elementId: args.elementId, text: text(element, 16384) };
          else throw new Error('INVALID_ARGUMENTS: Unsupported element action');
          return { elementId: args.elementId, action: args.action, completed: true };
        }
        if (command === 'snapshot') {
          const maximum = Math.max(1, Math.min(200, Number(args.maxNodes || 200)));
          const nodes = [];
          for (const element of document.querySelectorAll('a,button,input,select,textarea,[role],h1,h2,h3,p,li')) {
            if (visible(element)) nodes.push(describe(element));
            if (nodes.length >= maximum) break;
          }
          const result = { url: location.href, title: document.title.slice(0, 500), generation: state.generation, nodes, truncated: false };
          const encoder = new TextEncoder();
          while (encoder.encode(JSON.stringify(result)).length > 32768 && result.nodes.length) {
            result.nodes.pop(); result.truncated = true;
          }
          return result;
        }
        throw new Error('INVALID_COMMAND: Unsupported browser command');
      };
    })();
    """#
}

extension BrowserController: WKNavigationDelegate {
  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    isLoading = true
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    isLoading = false
    currentURL = webView.url
    if webView.url?.scheme == "about" { allowInternalBlank = false }
    lastError = nil
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    isLoading = false
    lastError = error.localizedDescription
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    isLoading = false
    lastError = error.localizedDescription
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
  ) {
    if navigationAction.shouldPerformDownload {
      lastError = "Downloads are disabled in Bridge Browser"
      decisionHandler(.cancel)
      return
    }
    if navigationAction.targetFrame?.isMainFrame == false {
      decisionHandler(.allow)
      return
    }
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    if allowInternalBlank && url.scheme == "about" {
      decisionHandler(.allow)
      return
    }
    guard isAllowed(url) else {
      lastError = "Blocked unapproved top-level navigation"
      decisionHandler(.cancel)
      return
    }
    if navigationAction.targetFrame == nil {
      webView.load(navigationAction.request)
      decisionHandler(.cancel)
    } else {
      decisionHandler(.allow)
    }
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationResponse: WKNavigationResponse,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
  ) {
    guard navigationResponse.canShowMIMEType else {
      lastError = "Downloads are disabled in Bridge Browser"
      decisionHandler(.cancel)
      return
    }
    decisionHandler(.allow)
  }
}

extension BrowserController: WKUIDelegate {
  func webView(
    _ webView: WKWebView,
    requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType,
    decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
  ) {
    decisionHandler(.deny)
  }
}
