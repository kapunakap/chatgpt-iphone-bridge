import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";

export const CELLULAR_PROTOCOL_VERSION = 1;
export const CELLULAR_MAX_CLOCK_SKEW_MS = 60_000;
export const CELLULAR_MAX_PLAINTEXT_BYTES = 2_250_000;
export const CELLULAR_MAX_MESSAGE_BYTES = 3 * 1024 * 1024;

function fromBase64url(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} must be base64url`);
  }
  return Buffer.from(value, "base64url");
}

function publicJwk(x963) {
  const bytes = Buffer.from(x963);
  if (bytes.length !== 65 || bytes[0] !== 0x04) throw new Error("P-256 public key is invalid");
  return {
    kty: "EC",
    crv: "P-256",
    x: bytes.subarray(1, 33).toString("base64url"),
    y: bytes.subarray(33, 65).toString("base64url"),
  };
}

function privateJwk(privateBytes, publicBytes) {
  return { ...publicJwk(publicBytes), d: Buffer.from(privateBytes).toString("base64url") };
}

export function helloSigningInput(hello) {
  return Buffer.from(
    [
      `v${CELLULAR_PROTOCOL_VERSION}`,
      hello.deviceId,
      hello.role,
      hello.connectionId,
      hello.ephemeralKey,
      hello.nonce,
      String(hello.sentAt),
    ].join("|"),
    "utf8",
  );
}

export function createSignedHello(identity, deviceId, role, now = Date.now) {
  const ecdh = createECDH("prime256v1");
  const ephemeralKey = ecdh.generateKeys();
  const hello = {
    v: CELLULAR_PROTOCOL_VERSION,
    type: "hello",
    deviceId,
    role,
    connectionId: randomUUID(),
    ephemeralKey: ephemeralKey.toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    sentAt: now(),
  };
  const privateKey = createPrivateKey({
    format: "jwk",
    key: privateJwk(
      fromBase64url(identity.signingPrivateKey, "signingPrivateKey"),
      fromBase64url(identity.signingPublicKey, "signingPublicKey"),
    ),
  });
  hello.signature = sign("sha256", helloSigningInput(hello), privateKey).toString("base64url");
  return { hello, ecdh };
}

export function verifyPeerHello(hello, { deviceId, expectedRole, peerSigningPublicKey, now = Date.now }) {
  if (!hello || hello.v !== CELLULAR_PROTOCOL_VERSION || hello.type !== "hello") {
    throw new Error("unsupported cellular hello");
  }
  if (hello.deviceId !== deviceId || hello.role !== expectedRole) {
    throw new Error("cellular hello identity does not match the pairing");
  }
  if (!Number.isSafeInteger(hello.sentAt) || Math.abs(now() - hello.sentAt) > CELLULAR_MAX_CLOCK_SKEW_MS) {
    throw new Error("cellular hello timestamp is outside the allowed clock skew");
  }
  if (typeof hello.connectionId !== "string" || !/^[a-f0-9-]{36}$/.test(hello.connectionId)) {
    throw new Error("cellular hello connection ID is invalid");
  }
  const ephemeralKey = fromBase64url(hello.ephemeralKey, "ephemeralKey");
  const nonce = fromBase64url(hello.nonce, "nonce");
  const signature = fromBase64url(hello.signature, "signature");
  if (ephemeralKey.length !== 65 || ephemeralKey[0] !== 0x04 || nonce.length !== 32) {
    throw new Error("cellular hello key material is invalid");
  }
  const publicKey = createPublicKey({
    format: "jwk",
    key: publicJwk(fromBase64url(peerSigningPublicKey, "peerSigningPublicKey")),
  });
  if (!verify("sha256", helloSigningInput(hello), publicKey, signature)) {
    throw new Error("cellular hello signature is invalid");
  }
  return { ephemeralKey, nonce };
}

export function deriveSessionKey({ localEcdh, localHello, peerHello }) {
  const peerKey = fromBase64url(peerHello.ephemeralKey, "peer ephemeralKey");
  const secret = localEcdh.computeSecret(peerKey);
  const orderedNonces = [localHello.nonce, peerHello.nonce].sort();
  const salt = createHash("sha256").update(orderedNonces.join("|")).digest();
  const info = Buffer.from(`iphone-bridge-cellular-v1|${localHello.deviceId}`, "utf8");
  return Buffer.from(hkdfSync("sha256", secret, salt, info, 32));
}

export function sealPayload(key, deviceId, payload) {
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  if (plaintext.length > CELLULAR_MAX_PLAINTEXT_BYTES) throw new Error("cellular payload is too large");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`iphone-bridge-cellular-v1|${deviceId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: CELLULAR_PROTOCOL_VERSION,
    type: "sealed",
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function openPayload(key, deviceId, envelope) {
  if (!envelope || envelope.v !== CELLULAR_PROTOCOL_VERSION || envelope.type !== "sealed") {
    throw new Error("unsupported cellular envelope");
  }
  const nonce = fromBase64url(envelope.nonce, "sealed nonce");
  const ciphertext = fromBase64url(envelope.ciphertext, "sealed ciphertext");
  const tag = fromBase64url(envelope.tag, "sealed tag");
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > CELLULAR_MAX_PLAINTEXT_BYTES) {
    throw new Error("cellular envelope is invalid");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(`iphone-bridge-cellular-v1|${deviceId}`, "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function validateFreshPayload(payload, { now = Date.now, replayCache, maxClockSkewMs = CELLULAR_MAX_CLOCK_SKEW_MS }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("cellular payload is invalid");
  if (typeof payload.messageId !== "string" || !/^[a-f0-9-]{36}$/.test(payload.messageId)) {
    throw new Error("cellular payload messageId is invalid");
  }
  if (!Number.isSafeInteger(payload.sentAt) || !Number.isSafeInteger(payload.expiresAt)) {
    throw new Error("cellular payload timestamps are invalid");
  }
  const current = now();
  if (payload.sentAt > current + maxClockSkewMs || payload.expiresAt < current || payload.expiresAt < payload.sentAt) {
    throw new Error("cellular payload is expired or from the future");
  }
  if (replayCache?.has(payload.messageId)) throw new Error("cellular payload replay detected");
  replayCache?.add(payload.messageId, payload.expiresAt);
  return payload;
}

export class ReplayCache {
  constructor({ now = Date.now, maxEntries = 2048 } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  has(messageId) {
    this.prune();
    return this.entries.has(messageId);
  }

  add(messageId, expiresAt) {
    this.prune();
    this.entries.set(messageId, expiresAt);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }

  prune() {
    const current = this.now();
    for (const [messageId, expiresAt] of this.entries) {
      if (expiresAt < current) this.entries.delete(messageId);
    }
  }
}
