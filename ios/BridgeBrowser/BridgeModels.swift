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

  var double: Double? {
    guard case .number(let value) = self else { return nil }
    return value
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

enum TrustedTargetKind: String, Codable, CaseIterable, Hashable, Identifiable, Sendable {
  case exactURL = "exact_url"
  case pathPrefix = "path_prefix"
  case origin

  var id: String { rawValue }

  var title: String {
    switch self {
    case .exactURL: return "Exact URL"
    case .pathPrefix: return "Path prefix"
    case .origin: return "Origin / domain"
    }
  }

  var explanation: String {
    switch self {
    case .exactURL: return "Only this exact HTTPS URL"
    case .pathPrefix: return "This path and descendants on the same origin"
    case .origin: return "All paths on this exact HTTPS origin"
    }
  }
}

struct TrustedTargetRule: Codable, Equatable, Identifiable, Sendable {
  let id: UUID
  let kind: TrustedTargetKind
  let value: String
  let createdAt: Date

  static func make(
    kind: TrustedTargetKind, url: URL, id: UUID = UUID(), createdAt: Date = Date()
  ) throws -> TrustedTargetRule {
    guard let canonical = url.bridgeCanonicalHTTPSURL, let origin = canonical.bridgeOrigin else {
      throw BridgeError(
        code: "INVALID_TRUSTED_TARGET",
        message: "Trusted targets must use HTTPS without embedded credentials")
    }

    let value: String
    switch kind {
    case .origin:
      value = origin
    case .exactURL:
      value = canonical.absoluteString
    case .pathPrefix:
      var components = URLComponents(url: canonical, resolvingAgainstBaseURL: false)
      components?.query = nil
      components?.fragment = nil
      guard let scopedURL = components?.url else {
        throw BridgeError(code: "INVALID_TRUSTED_TARGET", message: "Trusted target is invalid")
      }
      value = scopedURL.absoluteString
    }

    return TrustedTargetRule(id: id, kind: kind, value: value, createdAt: createdAt)
  }

  func matches(_ url: URL) -> Bool {
    guard let canonical = url.bridgeCanonicalHTTPSURL else { return false }

    switch kind {
    case .origin:
      return canonical.bridgeOrigin == value
    case .exactURL:
      return canonical.absoluteString == value
    case .pathPrefix:
      guard let ruleURL = URL(string: value), canonical.bridgeOrigin == ruleURL.bridgeOrigin else {
        return false
      }
      let rulePath = ruleURL.bridgePercentEncodedPath
      let candidatePath = canonical.bridgePercentEncodedPath
      if rulePath == "/" { return true }
      let boundary = rulePath.hasSuffix("/") ? String(rulePath.dropLast()) : rulePath
      return candidatePath == boundary || candidatePath.hasPrefix(boundary + "/")
    }
  }

  var scopeScore: Int {
    switch kind {
    case .origin: return 3_000_000
    case .pathPrefix:
      let pathLength = URL(string: value).map { $0.bridgePercentEncodedPath.count } ?? value.count
      return 2_000_000 - min(pathLength, 999_999)
    case .exactURL: return 1_000_000
    }
  }
}

struct TrustedTargetStore {
  private let defaults: UserDefaults
  private let key: String

  init(defaults: UserDefaults = .standard, key: String = "bridge.trusted-targets.v1") {
    self.defaults = defaults
    self.key = key
  }

  func load() throws -> [TrustedTargetRule] {
    guard let data = defaults.data(forKey: key) else { return [] }
    return try JSONDecoder().decode([TrustedTargetRule].self, from: data)
  }

  func save(_ rules: [TrustedTargetRule]) throws {
    defaults.set(try JSONEncoder().encode(rules), forKey: key)
  }
}

func bridgeURLIsAllowed(
  _ url: URL, allowedOrigins: Set<String>, trustedRule: TrustedTargetRule?
) -> Bool {
  guard let origin = url.bridgeOrigin, allowedOrigins.contains(origin) else { return false }
  return trustedRule?.matches(url) ?? true
}

struct CommandResult: Sendable {
  let value: JSONValue
}

extension URL {
  var bridgePercentEncodedPath: String {
    let path = URLComponents(url: self, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
    return path.isEmpty ? "/" : path
  }

  var bridgeSuggestedPathPrefixURL: URL? {
    guard let canonical = bridgeCanonicalHTTPSURL,
      var components = URLComponents(url: canonical, resolvingAgainstBaseURL: false)
    else { return nil }

    var path = components.percentEncodedPath
    if !path.hasSuffix("/"), let lastSlash = path.lastIndex(of: "/") {
      path = String(path[...lastSlash])
    }
    if path.isEmpty { path = "/" }
    components.percentEncodedPath = path
    components.query = nil
    components.fragment = nil
    return components.url
  }

  var bridgeCanonicalHTTPSURL: URL? {
    guard var components = URLComponents(url: self, resolvingAgainstBaseURL: false),
      components.scheme?.lowercased() == "https",
      components.user == nil,
      components.password == nil,
      let host = components.host, !host.isEmpty
    else { return nil }

    components.scheme = "https"
    components.host = host.lowercased()
    if components.port == 443 { components.port = nil }
    if components.percentEncodedPath.isEmpty { components.percentEncodedPath = "/" }
    components.fragment = nil
    return components.url
  }

  var bridgeOrigin: String? {
    guard let canonical = bridgeCanonicalHTTPSURL,
      var components = URLComponents(url: canonical, resolvingAgainstBaseURL: false)
    else { return nil }
    components.path = ""
    components.query = nil
    components.fragment = nil
    return components.string
  }
}
