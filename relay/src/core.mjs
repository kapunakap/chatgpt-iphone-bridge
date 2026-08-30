export const RELAY_PROTOCOL_VERSION = 1;
export const PAIRING_TTL_MS = 5 * 60_000;
export const MAX_RELAY_MESSAGE_BYTES = 3 * 1024 * 1024;
export const MAX_CONTROL_BODY_BYTES = 16 * 1024;
export const PAIRING_RATE_LIMIT = 10;
export const PAIRING_RATE_WINDOW_MS = 5 * 60_000;

const encoder = new TextEncoder();

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isUuid(value) {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

export function validatePublicKey(value, label = "public key") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(value)) {
    throw new Error(`${label} must be a base64url P-256 public key`);
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
  const decoded = atob(normalized);
  if (decoded.length !== 65 || decoded.charCodeAt(0) !== 0x04) {
    throw new Error(`${label} must be a P-256 uncompressed point`);
  }
  return value;
}

export function validateAlias(value) {
  const alias = String(value ?? "remote-iphone").trim();
  if (!alias || alias.length > 64 || /[\u0000-\u001f\u007f]/.test(alias)) {
    throw new Error("device alias must contain 1 to 64 printable characters");
  }
  return alias;
}

export function parseBearer(request) {
  const value = request.headers.get("Authorization") ?? "";
  const match = value.match(/^Bearer ([A-Za-z0-9_-]{32,})$/);
  if (!match) throw new Error("missing or invalid bearer token");
  return match[1];
}

export async function readJson(request) {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_CONTROL_BODY_BYTES) throw new Error("request body is too large");
  const text = await request.text();
  if (text.length > MAX_CONTROL_BODY_BYTES) throw new Error("request body is too large");
  const value = JSON.parse(text || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be a JSON object");
  return value;
}

export function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export class RelayHttpError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function publicError(error, status = 400, code = "INVALID_REQUEST") {
  return json(
    {
      error: {
        code: error?.code ?? code,
        message: error instanceof Error ? error.message : String(error),
      },
    },
    error?.status ?? status,
  );
}
