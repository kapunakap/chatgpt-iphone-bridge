import Combine
import CryptoKit
import Foundation

@MainActor
final class RelayClient: ObservableObject {
  typealias RequestHandler = @MainActor (String, [String: JSONValue]) async throws -> JSONValue

  @Published private(set) var relayConnected = false
  @Published private(set) var hostOnline = false
  @Published private(set) var secureReady = false
  @Published private(set) var lastError: String?

  private var credentials: PairingCredentials?
  private var signingIdentity: SigningIdentity?
  private var socket: URLSessionWebSocketTask?
  private var receiveTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var reconnectAttempt = 0
  private var shouldReconnect = false
  private var peerStatusKnown = false
  private var handshake: HandshakeState?
  private var peerConnectionId: String?
  private var sessionKey: SymmetricKey?
  private var replayCache: [String: Int64] = [:]
  private var handler: RequestHandler?

  var onSecureReady: (@MainActor () -> Void)?
  var onDisconnected: (@MainActor () -> Void)?

  func start(credentials: PairingCredentials, handler: @escaping RequestHandler) {
    self.credentials = credentials
    self.handler = handler
    do {
      signingIdentity = try SigningIdentity(rawPrivateKey: credentials.signingPrivateKey)
    } catch {
      lastError = "Stored signing identity is invalid"
      return
    }
    shouldReconnect = true
    connectIfNeeded()
  }

  func stop(reconnect: Bool = false) {
    shouldReconnect = reconnect
    reconnectTask?.cancel()
    reconnectTask = nil
    receiveTask?.cancel()
    receiveTask = nil
    socket?.cancel(with: .normalClosure, reason: nil)
    socket = nil
    resetConnectionState(notify: true)
  }

  func sendEvent(name: String, data: JSONValue) async {
    guard secureReady else { return }
    let now = BridgeCrypto.nowMs()
    let payload = SecurePayload(
      type: "event",
      messageId: UUID().uuidString.lowercased(),
      sentAt: now,
      expiresAt: now + 15_000,
      requestId: nil,
      command: nil,
      args: nil,
      ok: nil,
      result: nil,
      error: nil,
      name: name,
      data: data
    )
    try? await sendSecure(payload)
  }

  private func connectIfNeeded() {
    guard shouldReconnect, socket == nil, let credentials else { return }
    guard var components = URLComponents(string: credentials.relayUrl) else {
      lastError = "Relay URL is invalid"
      return
    }
    components.scheme = "wss"
    components.path = "/v1/devices/\(credentials.deviceId)/connect"
    components.queryItems = [
      URLQueryItem(name: "role", value: "device"),
      URLQueryItem(name: "replace", value: "1"),
    ]
    guard let url = components.url else {
      lastError = "Relay WebSocket URL is invalid"
      return
    }
    var request = URLRequest(url: url, timeoutInterval: 15)
    request.setValue("Bearer \(credentials.authToken)", forHTTPHeaderField: "Authorization")
    let task = URLSession.shared.webSocketTask(with: request)
    socket = task
    resetConnectionState(notify: false)
    task.resume()
    relayConnected = true
    receiveTask = Task { [weak self, weak task] in
      guard let self, let task else { return }
      await self.receiveLoop(task)
    }
  }

  private func receiveLoop(_ task: URLSessionWebSocketTask) async {
    do {
      while !Task.isCancelled, task === socket {
        let message = try await task.receive()
        let data: Data
        switch message {
        case .data(let value): data = value
        case .string(let value): data = Data(value.utf8)
        @unknown default:
          throw BridgeError(
            code: "INVALID_MESSAGE", message: "Relay returned an unsupported message")
        }
        guard data.count <= BridgeCrypto.maxMessageBytes else {
          throw BridgeError(code: "MESSAGE_TOO_LARGE", message: "Relay message exceeded 3 MiB")
        }
        try await handle(data)
      }
    } catch {
      guard task === socket else { return }
      lastError = (error as? BridgeError)?.message ?? error.localizedDescription
      socket = nil
      resetConnectionState(notify: true)
      scheduleReconnect()
    }
  }

  private func handle(_ data: Data) async throws {
    reconnectAttempt = 0
    let header = try JSONDecoder().decode(MessageHeader.self, from: data)
    guard header.v == BridgeCrypto.protocolVersion else {
      throw BridgeError(code: "PROTOCOL_MISMATCH", message: "Relay protocol version is unsupported")
    }
    switch header.type {
    case "relay.peer":
      let peer = try JSONDecoder().decode(RelayPeerMessage.self, from: data)
      let wasKnown = peerStatusKnown
      let wasOnline = hostOnline
      peerStatusKnown = true
      hostOnline = peer.online
      if !peer.online { resetSecureState(notify: true) }
      if (!wasKnown || !wasOnline) && peer.online { await sendHello() }
    case "hello":
      try await handleHello(try JSONDecoder().decode(HelloMessage.self, from: data))
    case "sealed":
      guard let sessionKey, let credentials else {
        // A readiness frame can overtake the peer hello when both sockets
        // reconnect together. Repeat our hello and wait for a decryptable
        // readiness frame instead of tearing down the healthy relay socket.
        await sendHello()
        return
      }
      let payload = try BridgeCrypto.open(
        try JSONDecoder().decode(SealedEnvelope.self, from: data),
        key: sessionKey,
        deviceId: credentials.deviceId
      )
      try validateFresh(payload)
      try await handleSecure(payload)
    default:
      throw BridgeError(code: "INVALID_MESSAGE", message: "Relay message type is unsupported")
    }
  }

  private func sendHello() async {
    guard let credentials, let signingIdentity, socket != nil else { return }
    do {
      let state = try BridgeCrypto.makeHello(
        identity: signingIdentity, deviceId: credentials.deviceId, role: "device")
      handshake = state
      try await sendJSON(state.hello)
    } catch {
      lastError = (error as? BridgeError)?.message ?? error.localizedDescription
    }
  }

  private func handleHello(_ hello: HelloMessage) async throws {
    guard let credentials else {
      throw BridgeError(code: "PAIRING_REQUIRED", message: "Device is not paired")
    }
    try BridgeCrypto.verifyHello(hello, credentials: credentials)
    let peerChanged = peerConnectionId != nil && peerConnectionId != hello.connectionId
    if handshake == nil || peerChanged {
      sessionKey = nil
      handshake = nil
      await sendHello()
    }
    guard let handshake else {
      throw BridgeError(code: "HANDSHAKE_FAILED", message: "Could not create device handshake")
    }
    sessionKey = try BridgeCrypto.deriveKey(
      local: handshake, peer: hello, deviceId: credentials.deviceId)
    peerConnectionId = hello.connectionId
    let now = BridgeCrypto.nowMs()
    let ready = SecurePayload(
      type: "secure_ready",
      messageId: UUID().uuidString.lowercased(),
      sentAt: now,
      expiresAt: now + 30_000,
      requestId: nil,
      command: nil,
      args: nil,
      ok: nil,
      result: nil,
      error: nil,
      name: nil,
      data: nil
    )
    try await sendSecure(ready)
  }

  private func handleSecure(_ payload: SecurePayload) async throws {
    if payload.type == "secure_ready" {
      if !secureReady {
        secureReady = true
        hostOnline = true
        lastError = nil
        onSecureReady?()
      }
      if payload.data?.object?["ack"] != .bool(true) {
        let now = BridgeCrypto.nowMs()
        let acknowledgement = SecurePayload(
          type: "secure_ready",
          messageId: UUID().uuidString.lowercased(),
          sentAt: now,
          expiresAt: now + 30_000,
          requestId: nil,
          command: nil,
          args: nil,
          ok: nil,
          result: nil,
          error: nil,
          name: nil,
          data: .object(["ack": .bool(true)])
        )
        try await sendSecure(acknowledgement)
      }
      return
    }
    guard payload.type == "request", let requestId = payload.requestId,
      let command = payload.command
    else {
      throw BridgeError(code: "INVALID_PAYLOAD", message: "Encrypted payload is unsupported")
    }
    let arguments = payload.args ?? [:]
    Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        guard let handler = self.handler else {
          throw BridgeError(
            code: "HANDLER_UNAVAILABLE", message: "Browser command handler is unavailable")
        }
        let result = try await handler(command, arguments)
        await self.sendResponse(requestId: requestId, result: result, error: nil)
      } catch {
        let bridgeError =
          error as? BridgeError
          ?? BridgeError(code: "COMMAND_FAILED", message: error.localizedDescription)
        await self.sendResponse(requestId: requestId, result: nil, error: bridgeError)
      }
    }
  }

  private func sendResponse(requestId: String, result: JSONValue?, error: BridgeError?) async {
    let now = BridgeCrypto.nowMs()
    let payload = SecurePayload(
      type: "response",
      messageId: UUID().uuidString.lowercased(),
      sentAt: now,
      expiresAt: now + 15_000,
      requestId: requestId,
      command: nil,
      args: nil,
      ok: error == nil,
      result: result,
      error: error.map { PayloadError(code: $0.code, message: $0.message) },
      name: nil,
      data: nil
    )
    try? await sendSecure(payload)
  }

  private func sendSecure(_ payload: SecurePayload) async throws {
    guard let sessionKey, let credentials else {
      throw BridgeError(code: "HANDSHAKE_REQUIRED", message: "Secure channel is not ready")
    }
    try await sendJSON(BridgeCrypto.seal(payload, key: sessionKey, deviceId: credentials.deviceId))
  }

  private func sendJSON<T: Encodable>(_ value: T) async throws {
    guard let socket else {
      throw BridgeError(code: "RELAY_OFFLINE", message: "Relay is disconnected")
    }
    let data = try JSONEncoder().encode(value)
    guard data.count <= BridgeCrypto.maxMessageBytes else {
      throw BridgeError(code: "MESSAGE_TOO_LARGE", message: "Relay message exceeded 3 MiB")
    }
    try await socket.send(.data(data))
  }

  private func validateFresh(_ payload: SecurePayload) throws {
    let now = BridgeCrypto.nowMs()
    guard UUID(uuidString: payload.messageId) != nil,
      payload.sentAt <= now + BridgeCrypto.maxClockSkewMs,
      payload.expiresAt >= now,
      payload.expiresAt >= payload.sentAt
    else {
      throw BridgeError(code: "EXPIRED_PAYLOAD", message: "Encrypted payload is expired or invalid")
    }
    replayCache = replayCache.filter { $0.value >= now }
    guard replayCache[payload.messageId] == nil else {
      throw BridgeError(code: "REPLAY_DETECTED", message: "Encrypted payload was replayed")
    }
    if replayCache.count >= 2048, let oldest = replayCache.min(by: { $0.value < $1.value })?.key {
      replayCache.removeValue(forKey: oldest)
    }
    replayCache[payload.messageId] = payload.expiresAt
  }

  private func resetSecureState(notify: Bool) {
    let wasReady = secureReady
    secureReady = false
    sessionKey = nil
    handshake = nil
    peerConnectionId = nil
    if notify && wasReady { onDisconnected?() }
  }

  private func resetConnectionState(notify: Bool) {
    relayConnected = false
    hostOnline = false
    peerStatusKnown = false
    resetSecureState(notify: notify)
  }

  private func scheduleReconnect() {
    guard shouldReconnect, reconnectTask == nil else { return }
    let delays: [UInt64] = [1, 2, 4, 8, 15, 30]
    let delay = delays[min(reconnectAttempt, delays.count - 1)]
    reconnectAttempt += 1
    reconnectTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard let self, !Task.isCancelled else { return }
      self.reconnectTask = nil
      self.connectIfNeeded()
    }
  }
}
