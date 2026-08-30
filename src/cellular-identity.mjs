import { createECDH, generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const IDENTITY_VERSION = 1;

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function fromBase64url(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} must be base64url`);
  }
  return Buffer.from(value, "base64url");
}

function publicKeyFromJwk(jwk) {
  const x = fromBase64url(jwk.x, "identity public key x");
  const y = fromBase64url(jwk.y, "identity public key y");
  if (x.length !== 32 || y.length !== 32) throw new Error("identity public key must use P-256");
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

function privateKeyFromJwk(jwk) {
  const value = fromBase64url(jwk.d, "identity private key");
  if (value.length !== 32) throw new Error("identity private key must use P-256");
  return value;
}

export function defaultCellularIdentityPath() {
  return path.join(os.homedir(), ".config", "chatgpt-iphone-bridge", "cellular-host.json");
}

export function createHostIdentity(alias = "remote-iphone") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  return {
    version: IDENTITY_VERSION,
    role: "host",
    alias,
    signingPrivateKey: base64url(privateKeyFromJwk(privateJwk)),
    signingPublicKey: base64url(publicKeyFromJwk(publicJwk)),
    createdAt: new Date().toISOString(),
  };
}

export function createPairingSecret() {
  return base64url(randomBytes(24));
}

export function validateHostIdentity(identity, { requirePairing = true } = {}) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("cellular identity must be a JSON object");
  }
  if (identity.version !== IDENTITY_VERSION || identity.role !== "host") {
    throw new Error("unsupported cellular host identity");
  }
  const privateKey = fromBase64url(identity.signingPrivateKey, "signingPrivateKey");
  const publicKey = fromBase64url(identity.signingPublicKey, "signingPublicKey");
  if (privateKey.length !== 32 || publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("cellular host identity must use P-256 keys");
  }
  const verifier = createECDH("prime256v1");
  verifier.setPrivateKey(privateKey);
  if (!verifier.getPublicKey().equals(publicKey)) throw new Error("cellular host identity public and private keys do not match");
  if (typeof identity.alias !== "string" || !identity.alias.trim()) {
    throw new Error("cellular host identity alias is missing");
  }

  if (requirePairing) {
    if (typeof identity.deviceId !== "string" || !/^[a-f0-9-]{36}$/.test(identity.deviceId)) {
      throw new Error("cellular identity is not paired with a device");
    }
    const peerKey = fromBase64url(identity.peerSigningPublicKey, "peerSigningPublicKey");
    if (peerKey.length !== 65 || peerKey[0] !== 0x04) {
      throw new Error("paired device public key must use P-256");
    }
    const authToken = fromBase64url(identity.authToken, "authToken");
    if (authToken.length < 24) throw new Error("cellular relay auth token is invalid");
  }
  return identity;
}

export async function loadHostIdentity(identityPath = defaultCellularIdentityPath(), options = {}) {
  const stat = await fs.stat(identityPath);
  if (!stat.isFile()) throw new Error(`cellular identity is not a file: ${identityPath}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`cellular identity permissions must be 600: ${identityPath}`);
  if (typeof stat.uid === "number" && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`cellular identity must be owned by the current user: ${identityPath}`);
  }
  const identity = JSON.parse(await fs.readFile(identityPath, "utf8"));
  return validateHostIdentity(identity, options);
}

export async function saveHostIdentity(identityPath, identity) {
  validateHostIdentity(identity, { requirePairing: false });
  await fs.mkdir(path.dirname(identityPath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(identityPath), 0o700);
  const temporaryPath = `${identityPath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(temporaryPath, 0o600);
  await fs.rename(temporaryPath, identityPath);
  await fs.chmod(identityPath, 0o600);
}

export { IDENTITY_VERSION };
