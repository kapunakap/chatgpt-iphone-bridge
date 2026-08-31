import Combine
import Foundation
import UIKit

@MainActor
final class AppModel: ObservableObject {
  @Published private(set) var credentials: PairingCredentials?
  @Published private(set) var pendingApproval: PendingApproval?
  @Published private(set) var activeSessionId: String?
  @Published var pairingText = ""
  @Published private(set) var statusMessage = "Not paired"
  @Published private(set) var errorMessage: String?

  let relay = RelayClient()
  let browser = BrowserController()

  private var approvalContinuation: CheckedContinuation<Bool, Never>?
  private var reconnectGraceTask: Task<Void, Never>?

  init() {
    do {
      credentials = try PairingStore.load()
      statusMessage = credentials == nil ? "Not paired" : "Paired — open connection"
    } catch {
      errorMessage = error.localizedDescription
    }
    relay.onSecureReady = { [weak self] in
      self?.reconnectGraceTask?.cancel()
      self?.reconnectGraceTask = nil
      self?.statusMessage =
        self?.activeSessionId == nil ? "Secure channel ready" : "Cellular session active"
    }
    relay.onDisconnected = { [weak self] in
      guard let self else { return }
      if self.pendingApproval != nil { self.resolveApproval(false) }
      if let sessionId = self.activeSessionId {
        self.reconnectGraceTask?.cancel()
        self.reconnectGraceTask = Task { @MainActor [weak self] in
          try? await Task.sleep(for: .seconds(30))
          guard let self, !Task.isCancelled, self.activeSessionId == sessionId,
            !self.relay.secureReady
          else { return }
          self.closeLocalSession()
          self.statusMessage = "Session ended after cellular reconnect timeout"
        }
      }
      self.statusMessage = self.credentials == nil ? "Not paired" : "Reconnecting…"
    }
  }

  func enterForeground() {
    guard let credentials else { return }
    relay.start(credentials: credentials) { [weak self] command, args in
      guard let self else {
        throw BridgeError(code: "APP_UNAVAILABLE", message: "Bridge Browser is unavailable")
      }
      return try await self.handle(command: command, args: args)
    }
    statusMessage =
      relay.secureReady
      ? (activeSessionId == nil ? "Secure channel ready" : "Cellular session active")
      : "Connecting…"
  }

  func reconnect() {
    guard credentials != nil else { return }
    relay.stop(reconnect: false)
    enterForeground()
  }

  func leaveForeground() async {
    resolveApproval(false)
    if let sessionId = activeSessionId {
      await relay.sendEvent(
        name: "session.closed",
        data: .object([
          "sessionId": .string(sessionId), "reason": .string("app_backgrounded"),
        ]))
    }
    closeLocalSession()
    relay.stop(reconnect: false)
    statusMessage = credentials == nil ? "Not paired" : "Open the app to reconnect"
  }

  func pair() async {
    errorMessage = nil
    do {
      let payload = try JSONDecoder().decode(
        PairingPayload.self,
        from: Data(pairingText.trimmingCharacters(in: .whitespacesAndNewlines).utf8))
      guard payload.version == 1, UUID(uuidString: payload.deviceId) != nil else {
        throw BridgeError(code: "INVALID_PAIRING", message: "Pairing payload is invalid")
      }
      guard payload.expiresAt >= BridgeCrypto.nowMs() else {
        throw BridgeError(
          code: "PAIRING_EXPIRED", message: "Pairing payload expired; create a new one on the Mac")
      }
      guard let baseURL = URL(string: payload.relayUrl), baseURL.scheme == "https",
        baseURL.user == nil, baseURL.password == nil
      else {
        throw BridgeError(code: "INVALID_PAIRING", message: "Pairing relay must use HTTPS")
      }
      let identity = SigningIdentity.create()
      var requestComponents = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
      requestComponents?.path = "/v1/devices/\(payload.deviceId)/pair/complete"
      requestComponents?.query = nil
      requestComponents?.fragment = nil
      guard let requestURL = requestComponents?.url else {
        throw BridgeError(code: "INVALID_PAIRING", message: "Pairing relay URL is invalid")
      }
      var request = URLRequest(url: requestURL, timeoutInterval: 15)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: [
        "secret": payload.secret,
        "devicePublicKey": identity.publicKeyEncoded,
      ])
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
        let message =
          (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
          .flatMap { $0["error"] as? [String: Any] }?["message"] as? String
        throw BridgeError(
          code: "PAIRING_FAILED", message: message ?? "Relay rejected the pairing request")
      }
      let paired = try JSONDecoder().decode(PairingResponse.self, from: data)
      guard paired.version == 1, paired.deviceId == payload.deviceId else {
        throw BridgeError(
          code: "PAIRING_FAILED", message: "Relay returned inconsistent pairing data")
      }
      let credentials = PairingCredentials(
        version: 1,
        relayUrl: payload.relayUrl,
        deviceId: paired.deviceId,
        alias: paired.alias,
        authToken: paired.authToken,
        peerSigningPublicKey: paired.peerSigningPublicKey,
        signingPrivateKey: identity.privateKeyEncoded,
        signingPublicKey: identity.publicKeyEncoded,
        pairedAt: ISO8601DateFormatter().string(from: Date())
      )
      try PairingStore.save(credentials)
      self.credentials = credentials
      pairingText = ""
      statusMessage = "Paired — connecting…"
      enterForeground()
    } catch {
      errorMessage = (error as? BridgeError)?.message ?? error.localizedDescription
    }
  }

  func forgetPairing() {
    Task { await leaveForeground() }
    do {
      try PairingStore.clear()
      credentials = nil
      statusMessage = "Not paired"
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func approvePending() { resolveApproval(true) }
  func rejectPending() { resolveApproval(false) }
  func reportError(_ message: String) { errorMessage = message }

  func stopActiveSession() async {
    guard let sessionId = activeSessionId else { return }
    await relay.sendEvent(
      name: "session.closed",
      data: .object([
        "sessionId": .string(sessionId), "reason": .string("stopped_on_iphone"),
      ]))
    closeLocalSession()
  }

  func clearWebsiteData() async {
    guard activeSessionId == nil else {
      errorMessage = "Stop the active session before clearing website data"
      return
    }
    do {
      try await browser.clearWebsiteData()
      statusMessage = "Browsing data cleared"
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func resolveApproval(_ approved: Bool) {
    pendingApproval = nil
    let continuation = approvalContinuation
    approvalContinuation = nil
    continuation?.resume(returning: approved)
  }

  private func handle(command: String, args: [String: JSONValue]) async throws -> JSONValue {
    switch command {
    case "session.start": return try await startSession(args)
    case "session.cancel":
      let operationId = try requiredString(args, "operationId")
      guard operationId == pendingApproval?.id else {
        throw BridgeError(
          code: "NO_PENDING_APPROVAL", message: "No matching session approval is pending")
      }
      resolveApproval(false)
      return .object(["state": .string("cancelled")])
    case "session.resume":
      let sessionId = try requiredString(args, "sessionId")
      guard sessionId == activeSessionId else {
        throw BridgeError(code: "SESSION_NOT_ACTIVE", message: "Session cannot be resumed")
      }
      return .object(["state": .string("ready"), "sessionId": .string(sessionId)])
    case "session.stop":
      try requireSession(args)
      closeLocalSession()
      return .object(["state": .string("closed")])
    case "page.navigate":
      try requireSession(args)
      let action = try requiredString(args, "action")
      let url = args["url"]?.string.flatMap(URL.init(string:))
      return try await browser.navigate(action: action, url: url)
    case "element.find":
      try requireSession(args)
      return try await browser.find(
        strategy: try requiredString(args, "strategy"),
        selector: try requiredString(args, "selector"),
        limit: args["limit"]?.int ?? 20
      )
    case "element.action":
      try requireSession(args)
      return try await browser.element(
        action: try requiredString(args, "action"),
        elementId: try requiredString(args, "elementId"),
        text: args["text"]?.string,
        durationMs: args["durationMs"]?.int,
        x: args["x"]?.double,
        y: args["y"]?.double,
        endX: args["endX"]?.double,
        endY: args["endY"]?.double
      )
    case "page.snapshot":
      try requireSession(args)
      return try await browser.snapshot(maxNodes: args["maxNodes"]?.int ?? 200)
    case "page.screenshot":
      try requireSession(args)
      return try await browser.screenshot(maxWidth: args["maxWidth"]?.int ?? 800)
    default: throw BridgeError(code: "INVALID_COMMAND", message: "Browser command is unsupported")
    }
  }

  private func startSession(_ args: [String: JSONValue]) async throws -> JSONValue {
    guard activeSessionId == nil, pendingApproval == nil, approvalContinuation == nil else {
      throw BridgeError(
        code: "SESSION_ACTIVE", message: "Another browser session or approval is active")
    }
    let operationId = try requiredString(args, "operationId")
    guard let initialURL = URL(string: try requiredString(args, "initialUrl")),
      let initialOrigin = initialURL.bridgeOrigin
    else {
      throw BridgeError(
        code: "INVALID_URL", message: "Initial URL must use HTTPS without credentials")
    }
    guard case .array(let originValues) = args["allowedOrigins"] else {
      throw BridgeError(code: "INVALID_ORIGINS", message: "Allowed origins are required")
    }
    let origins = try originValues.map { value -> String in
      guard let raw = value.string, let url = URL(string: raw), let origin = url.bridgeOrigin else {
        throw BridgeError(code: "INVALID_ORIGINS", message: "Every approved origin must use HTTPS")
      }
      return origin
    }
    guard origins.count <= 10, Set(origins).count == origins.count, origins.contains(initialOrigin)
    else {
      throw BridgeError(
        code: "INVALID_ORIGINS",
        message: "Approved origins are duplicated, missing, or do not include the initial origin")
    }
    pendingApproval = PendingApproval(
      id: operationId, initialURL: initialURL, allowedOrigins: origins)
    statusMessage = "Session approval required"
    await relay.sendEvent(
      name: "session.approval_pending",
      data: .object(["operationId": .string(operationId)]))
    let approved = await withCheckedContinuation { continuation in
      approvalContinuation = continuation
    }
    guard approved else {
      statusMessage = "Session rejected"
      return .object(["state": .string("rejected")])
    }
    let sessionId = UUID().uuidString.lowercased()
    try browser.begin(initialURL: initialURL, allowedOrigins: origins)
    activeSessionId = sessionId
    UIApplication.shared.isIdleTimerDisabled = true
    statusMessage = "Cellular session active"
    return .object([
      "state": .string("ready"),
      "sessionId": .string(sessionId),
      "currentUrl": .string(initialURL.absoluteString),
    ])
  }

  private func requireSession(_ args: [String: JSONValue]) throws {
    let sessionId = try requiredString(args, "sessionId")
    guard sessionId == activeSessionId else {
      throw BridgeError(
        code: "SESSION_NOT_ACTIVE", message: "Cellular browser session is not active")
    }
  }

  private func requiredString(_ args: [String: JSONValue], _ key: String) throws -> String {
    guard let value = args[key]?.string, !value.isEmpty else {
      throw BridgeError(code: "INVALID_ARGUMENTS", message: "\(key) is required")
    }
    return value
  }

  private func closeLocalSession() {
    reconnectGraceTask?.cancel()
    reconnectGraceTask = nil
    resolveApproval(false)
    activeSessionId = nil
    UIApplication.shared.isIdleTimerDisabled = false
    browser.stop()
    statusMessage = credentials == nil ? "Not paired" : "Secure channel ready"
  }
}
