import Foundation

enum JSONValue: Codable, Equatable, Sendable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object([String: JSONValue])
  case array([JSONValue])
  case null

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([String: JSONValue].self) {
      self = .object(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      throw DecodingError.dataCorruptedError(
        in: container, debugDescription: "Unsupported JSON value")
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .bool(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .null: try container.encodeNil()
    }
  }

  var string: String? {
    guard case .string(let value) = self else { return nil }
    return value
  }

  var int: Int? {
    guard case .number(let value) = self, value.rounded() == value else { return nil }
    return Int(value)
  }

  var object: [String: JSONValue]? {
    guard case .object(let value) = self else { return nil }
    return value
  }

  static func from(any value: Any) throws -> JSONValue {
    switch value {
    case let value as String: return .string(value)
    case let value as Bool: return .bool(value)
    case let value as NSNumber: return .number(value.doubleValue)
    case let value as [String: Any]: return .object(try value.mapValues(JSONValue.from))
    case let value as [Any]: return .array(try value.map(JSONValue.from))
    case is NSNull: return .null
    default:
      throw BridgeError(
        code: "INVALID_BROWSER_RESULT", message: "Browser returned an unsupported JSON value")
    }
  }
}

struct BridgeError: Error, Codable, Equatable, Sendable {
  let code: String
  let message: String
}

struct PairingPayload: Codable, Sendable {
  let version: Int
  let relayUrl: String
  let deviceId: String
  let secret: String
  let expiresAt: Int64
}

struct PairingResponse: Codable, Sendable {
  let version: Int
  let deviceId: String
  let alias: String
  let authToken: String
  let peerSigningPublicKey: String
}

struct PairingCredentials: Codable, Sendable {
  let version: Int
  let relayUrl: String
  let deviceId: String
  let alias: String
  let authToken: String
  let peerSigningPublicKey: String
  let signingPrivateKey: String
  let signingPublicKey: String
  let pairedAt: String
}

struct HelloMessage: Codable, Sendable {
  let v: Int
  let type: String
  let deviceId: String
  let role: String
  let connectionId: String
  let ephemeralKey: String
  let nonce: String
  let sentAt: Int64
  let signature: String
}

struct SealedEnvelope: Codable, Sendable {
  let v: Int
  let type: String
  let nonce: String
  let ciphertext: String
  let tag: String
}

struct PayloadError: Codable, Sendable {
  let code: String
  let message: String
}

struct SecurePayload: Codable, Sendable {
  let type: String
  let messageId: String
  let sentAt: Int64
  let expiresAt: Int64
  var requestId: String?
  var command: String?
  var args: [String: JSONValue]?
  var ok: Bool?
  var result: JSONValue?
  var error: PayloadError?
  var name: String?
  var data: JSONValue?
}

struct MessageHeader: Codable {
  let v: Int
  let type: String
}

struct RelayPeerMessage: Codable {
  let v: Int
  let type: String
  let online: Bool
}

struct PendingApproval: Identifiable, Equatable {
  let id: String
  let initialURL: URL
  let allowedOrigins: [String]
}

struct CommandResult: Sendable {
  let value: JSONValue
}

extension URL {
  var bridgeOrigin: String? {
    guard scheme == "https", user == nil, password == nil, let host else { return nil }
    var components = URLComponents()
    components.scheme = scheme
    components.host = host
    if port != 443 { components.port = port }
    return components.string
  }
}
