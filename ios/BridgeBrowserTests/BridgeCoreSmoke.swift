import CryptoKit
import Foundation

@main
enum BridgeCoreSmoke {
  struct Vector: Codable {
    let key: String
    let deviceId: String
    let envelope: SealedEnvelope
    let payload: SecurePayload
  }

  static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw BridgeError(code: "SMOKE_FAILED", message: message) }
  }

  static func keyData(_ key: SymmetricKey) -> Data {
    key.withUnsafeBytes { Data($0) }
  }

  static func main() throws {
    let deviceId = "11111111-1111-4111-8111-111111111111"
    let fixedKeyData = Data((0..<32).map(UInt8.init))
    let fixedKey = SymmetricKey(data: fixedKeyData)
    let nodeEnvelope = SealedEnvelope(
      v: 1,
      type: "sealed",
      nonce: "AAECAwQFBgcICQoL",
      ciphertext:
        "PCCiYrWA4CGvMvLoxJsdMvGz5lCJWXNeVQKW9nwOZftlMpTenfMgqkaWTd-ltRoK3HRUv2jkjuINpRg0KtHH3MIO9Ejh4xRTPniIHYrheqlMqPNTRlNjRN-Y5rwRgtz-iox73JZx-Crj",
      tag: "zV3UULHa-ifkFm-vOnEz8A"
    )
    let nodePayload = try BridgeCrypto.open(nodeEnvelope, key: fixedKey, deviceId: deviceId)
    try require(
      nodePayload.type == "secure_ready", "Swift could not decrypt the Node AES-GCM vector")
    try require(
      nodePayload.messageId == "22222222-2222-4222-8222-222222222222", "Node vector payload changed"
    )

    let hostIdentity = SigningIdentity.create()
    let deviceIdentity = SigningIdentity.create()
    let host = try BridgeCrypto.makeHello(identity: hostIdentity, deviceId: deviceId, role: "host")
    let device = try BridgeCrypto.makeHello(
      identity: deviceIdentity, deviceId: deviceId, role: "device")
    let deviceCredentials = PairingCredentials(
      version: 1,
      relayUrl: "https://relay.example",
      deviceId: deviceId,
      alias: "phone",
      authToken: "unused",
      peerSigningPublicKey: hostIdentity.publicKeyEncoded,
      signingPrivateKey: deviceIdentity.privateKeyEncoded,
      signingPublicKey: deviceIdentity.publicKeyEncoded,
      pairedAt: "2026-08-30T00:00:00Z"
    )
    try BridgeCrypto.verifyHello(host.hello, credentials: deviceCredentials)
    let hostKey = try BridgeCrypto.deriveKey(local: host, peer: device.hello, deviceId: deviceId)
    let deviceKey = try BridgeCrypto.deriveKey(local: device, peer: host.hello, deviceId: deviceId)
    try require(keyData(hostKey) == keyData(deviceKey), "P-256 handshake keys do not match")

    try require(
      URL(string: "https://example.test:8443/path")?.bridgeOrigin == "https://example.test:8443",
      "HTTPS origin normalization failed")
    try require(
      URL(string: "http://example.test")?.bridgeOrigin == nil, "HTTP origin was not rejected")
    try require(
      URL(string: "https://user:pass@example.test")?.bridgeOrigin == nil,
      "Credentialed URL was not rejected")

    let now = BridgeCrypto.nowMs()
    let swiftPayload = SecurePayload(
      type: "event",
      messageId: "33333333-3333-4333-8333-333333333333",
      sentAt: now,
      expiresAt: now + 15_000,
      requestId: nil,
      command: nil,
      args: nil,
      ok: nil,
      result: nil,
      error: nil,
      name: "session.closed",
      data: .object(["sessionId": .string("44444444-4444-4444-8444-444444444444")])
    )
    let vector = Vector(
      key: Base64URL.encode(fixedKeyData),
      deviceId: deviceId,
      envelope: try BridgeCrypto.seal(swiftPayload, key: fixedKey, deviceId: deviceId),
      payload: swiftPayload
    )
    print(String(data: try JSONEncoder().encode(vector), encoding: .utf8)!)
  }
}
