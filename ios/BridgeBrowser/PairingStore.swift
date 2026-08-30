import Foundation
import Security

enum PairingStore {
  private static let service = "chatgpt-iphone-bridge.cellular"
  private static let account = "paired-device"

  static func load() throws -> PairingCredentials? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw BridgeError(
        code: "KEYCHAIN_READ_FAILED", message: "Could not read cellular pairing from Keychain")
    }
    return try JSONDecoder().decode(PairingCredentials.self, from: data)
  }

  static func save(_ credentials: PairingCredentials) throws {
    let data = try JSONEncoder().encode(credentials)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if update == errSecItemNotFound {
      var insert = query
      insert.merge(attributes) { _, new in new }
      let status = SecItemAdd(insert as CFDictionary, nil)
      guard status == errSecSuccess else {
        throw BridgeError(
          code: "KEYCHAIN_WRITE_FAILED", message: "Could not store cellular pairing in Keychain")
      }
    } else if update != errSecSuccess {
      throw BridgeError(
        code: "KEYCHAIN_WRITE_FAILED", message: "Could not update cellular pairing in Keychain")
    }
  }

  static func clear() throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw BridgeError(code: "KEYCHAIN_DELETE_FAILED", message: "Could not clear cellular pairing")
    }
  }
}
