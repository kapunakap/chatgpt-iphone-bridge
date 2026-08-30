import CryptoKit
import Foundation

enum Base64URL {
  static func encode(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func decode(_ value: String) throws -> Data {
    guard value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
      throw BridgeError(code: "INVALID_BASE64URL", message: "Protocol value is not base64url")
    }
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(
      of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    guard let data = Data(base64Encoded: base64) else {
      throw BridgeError(code: "INVALID_BASE64URL", message: "Protocol value is not valid base64url")
    }
    return data
  }
}

struct SigningIdentity: Sendable {
  let privateKey: P256.Signing.PrivateKey

  static func create() -> SigningIdentity { SigningIdentity(privateKey: P256.Signing.PrivateKey()) }

  init(privateKey: P256.Signing.PrivateKey) { self.privateKey = privateKey }

  init(rawPrivateKey: String) throws {
    privateKey = try P256.Signing.PrivateKey(rawRepresentation: Base64URL.decode(rawPrivateKey))
  }

  var privateKeyEncoded: String { Base64URL.encode(privateKey.rawRepresentation) }
  var publicKeyEncoded: String { Base64URL.encode(privateKey.publicKey.x963Representation) }
}

struct HandshakeState: Sendable {
  let hello: HelloMessage
  let ephemeralKey: P256.KeyAgreement.PrivateKey
}

enum BridgeCrypto {
  static let protocolVersion = 1
  static let maxClockSkewMs: Int64 = 60_000
  static let maxPlaintextBytes = 2_250_000
  static let maxMessageBytes = 3 * 1024 * 1024

  static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

  static func helloSigningData(_ hello: HelloMessage) -> Data {
    Data(
      [
        "v1", hello.deviceId, hello.role, hello.connectionId, hello.ephemeralKey, hello.nonce,
        String(hello.sentAt),
      ].joined(separator: "|").utf8)
  }

  static func makeHello(identity: SigningIdentity, deviceId: String, role: String) throws
    -> HandshakeState
  {
    let ephemeral = P256.KeyAgreement.PrivateKey()
    var nonce = Data(count: 32)
    let result = nonce.withUnsafeMutableBytes {
      SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!)
    }
    guard result == errSecSuccess else {
      throw BridgeError(code: "RANDOM_FAILED", message: "Could not create handshake nonce")
    }
    let unsigned = HelloMessage(
      v: protocolVersion,
      type: "hello",
      deviceId: deviceId,
      role: role,
      connectionId: UUID().uuidString.lowercased(),
      ephemeralKey: Base64URL.encode(ephemeral.publicKey.x963Representation),
      nonce: Base64URL.encode(nonce),
      sentAt: nowMs(),
      signature: ""
    )
    let signature = try identity.privateKey.signature(for: helloSigningData(unsigned))
    let hello = HelloMessage(
      v: unsigned.v,
      type: unsigned.type,
      deviceId: unsigned.deviceId,
      role: unsigned.role,
      connectionId: unsigned.connectionId,
      ephemeralKey: unsigned.ephemeralKey,
      nonce: unsigned.nonce,
      sentAt: unsigned.sentAt,
      signature: Base64URL.encode(signature.derRepresentation)
    )
    return HandshakeState(hello: hello, ephemeralKey: ephemeral)
  }

  static func verifyHello(_ hello: HelloMessage, credentials: PairingCredentials) throws {
    guard hello.v == protocolVersion, hello.type == "hello", hello.deviceId == credentials.deviceId,
      hello.role == "host"
    else {
      throw BridgeError(
        code: "INVALID_HELLO", message: "Host handshake does not match this pairing")
    }
    guard abs(nowMs() - hello.sentAt) <= maxClockSkewMs else {
      throw BridgeError(
        code: "INVALID_HELLO", message: "Host handshake clock is outside the allowed skew")
    }
    let publicKey = try P256.Signing.PublicKey(
      x963Representation: Base64URL.decode(credentials.peerSigningPublicKey))
    let signature = try P256.Signing.ECDSASignature(
      derRepresentation: Base64URL.decode(hello.signature))
    guard publicKey.isValidSignature(signature, for: helloSigningData(hello)) else {
      throw BridgeError(code: "INVALID_HELLO", message: "Host handshake signature is invalid")
    }
  }

  static func deriveKey(local: HandshakeState, peer: HelloMessage, deviceId: String) throws
    -> SymmetricKey
  {
    let peerKey = try P256.KeyAgreement.PublicKey(
      x963Representation: Base64URL.decode(peer.ephemeralKey))
    let secret = try local.ephemeralKey.sharedSecretFromKeyAgreement(with: peerKey)
    let nonceText = [local.hello.nonce, peer.nonce].sorted().joined(separator: "|")
    let salt = Data(SHA256.hash(data: Data(nonceText.utf8)))
    return secret.hkdfDerivedSymmetricKey(
      using: SHA256.self,
      salt: salt,
      sharedInfo: Data("iphone-bridge-cellular-v1|\(deviceId)".utf8),
      outputByteCount: 32
    )
  }

  static func seal(_ payload: SecurePayload, key: SymmetricKey, deviceId: String) throws
    -> SealedEnvelope
  {
    let plaintext = try JSONEncoder().encode(payload)
    guard plaintext.count <= maxPlaintextBytes else {
      throw BridgeError(code: "MESSAGE_TOO_LARGE", message: "Encrypted payload is too large")
    }
    let nonce = AES.GCM.Nonce()
    let sealed = try AES.GCM.seal(
      plaintext,
      using: key,
      nonce: nonce,
      authenticating: Data("iphone-bridge-cellular-v1|\(deviceId)".utf8)
    )
    return SealedEnvelope(
      v: protocolVersion,
      type: "sealed",
      nonce: Base64URL.encode(Data(nonce)),
      ciphertext: Base64URL.encode(sealed.ciphertext),
      tag: Base64URL.encode(sealed.tag)
    )
  }

  static func open(_ envelope: SealedEnvelope, key: SymmetricKey, deviceId: String) throws
    -> SecurePayload
  {
    guard envelope.v == protocolVersion, envelope.type == "sealed" else {
      throw BridgeError(code: "INVALID_ENVELOPE", message: "Unsupported encrypted envelope")
    }
    let nonceData = try Base64URL.decode(envelope.nonce)
    let ciphertext = try Base64URL.decode(envelope.ciphertext)
    let tag = try Base64URL.decode(envelope.tag)
    guard nonceData.count == 12, tag.count == 16, ciphertext.count <= maxPlaintextBytes else {
      throw BridgeError(code: "INVALID_ENVELOPE", message: "Encrypted envelope has invalid sizes")
    }
    let box = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: nonceData), ciphertext: ciphertext, tag: tag)
    let plaintext = try AES.GCM.open(
      box,
      using: key,
      authenticating: Data("iphone-bridge-cellular-v1|\(deviceId)".utf8)
    )
    return try JSONDecoder().decode(SecurePayload.self, from: plaintext)
  }
}
