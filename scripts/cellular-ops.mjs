#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import { fileURLToPath } from "node:url";

import {
  createHostIdentity,
  defaultCellularIdentityPath,
  loadHostIdentity,
  saveHostIdentity,
} from "../src/cellular-identity.mjs";

const action = process.argv[2];
const relayArgument = process.argv[3];

export function relayHttpUrl(value) {
  const url = new URL(value);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "https:") throw new Error("cellular relay URL must use https or wss");
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

export function createPairingPayload(relayUrl, started) {
  return JSON.stringify({
    version: 1,
    relayUrl: relayHttpUrl(relayUrl).href.replace(/\/$/, ""),
    deviceId: started.deviceId,
    secret: started.secret,
    expiresAt: started.expiresAt,
  });
}

function endpoint(relayUrl, pathname) {
  return new URL(pathname, `${relayHttpUrl(relayUrl).href.replace(/\/$/, "")}/`).href;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `relay returned HTTP ${response.status}`);
    error.code = payload?.error?.code ?? "RELAY_HTTP_ERROR";
    error.status = response.status;
    throw error;
  }
  return payload;
}

function identityPath() {
  return process.env.IPHONE_BRIDGE_CELLULAR_IDENTITY_FILE ?? defaultCellularIdentityPath();
}

function relayUrl() {
  const value = relayArgument ?? process.env.IPHONE_BRIDGE_CELLULAR_RELAY_URL;
  if (!value) throw new Error("Set IPHONE_BRIDGE_CELLULAR_RELAY_URL or pass the relay URL as the final argument");
  return relayHttpUrl(value).href.replace(/\/$/, "");
}

async function pair() {
  const targetPath = identityPath();
  try {
    const existing = await loadHostIdentity(targetPath, { requirePairing: false });
    if (existing.deviceId && existing.authToken && !existing.revokedAt) {
      throw new Error(`A paired cellular identity already exists: ${targetPath}. Revoke it before pairing again.`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const baseUrl = relayUrl();
  const identity = createHostIdentity(process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_ALIAS ?? "remote-iphone");
  const started = await jsonRequest(endpoint(baseUrl, "/v1/pair/start"), {
    method: "POST",
    body: JSON.stringify({ hostPublicKey: identity.signingPublicKey, alias: identity.alias }),
  });
  const payload = createPairingPayload(baseUrl, started);
  console.log("Scan this QR in Bridge Browser, or paste the pairing payload manually:");
  console.log(await QRCode.toString(payload, { type: "terminal", small: true, errorCorrectionLevel: "M" }));
  console.log(`pairing_payload=${payload}`);
  console.log(`expires_at=${new Date(started.expiresAt).toISOString()}`);

  while (Date.now() < started.expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await jsonRequest(endpoint(baseUrl, `/v1/devices/${started.deviceId}/pair/status`), {
      method: "POST",
      body: JSON.stringify({ secret: started.secret }),
    });
    if (status.state !== "paired") continue;
    const paired = {
      ...identity,
      deviceId: status.deviceId,
      authToken: started.hostToken,
      peerSigningPublicKey: status.peerSigningPublicKey,
      relayUrl: baseUrl,
      pairedAt: new Date().toISOString(),
    };
    await saveHostIdentity(targetPath, paired);
    console.log(`identity_file=${targetPath}`);
    console.log("CELLULAR_PAIRING_READY=1");
    return;
  }
  throw new Error("cellular pairing expired before the iPhone completed it");
}

async function status({ quiet = false } = {}) {
  const identity = await loadHostIdentity(identityPath());
  const baseUrl = relayArgument ?? process.env.IPHONE_BRIDGE_CELLULAR_RELAY_URL ?? identity.relayUrl;
  if (!baseUrl) throw new Error("cellular relay URL is missing from the environment and identity file");
  const result = await jsonRequest(endpoint(baseUrl, `/v1/devices/${identity.deviceId}/status`), {
    method: "GET",
    headers: { Authorization: `Bearer ${identity.authToken}`, "X-Bridge-Role": "host" },
  });
  const redacted = {
    configured: true,
    alias: identity.alias,
    paired: result.paired === true,
    revoked: result.revoked === true,
    hostOnline: result.hostOnline === true,
    deviceOnline: result.deviceOnline === true,
  };
  if (!quiet) for (const [key, value] of Object.entries(redacted)) console.log(`${key}=${value}`);
  return redacted;
}

async function doctor() {
  const identity = await loadHostIdentity(identityPath());
  const baseUrl = relayArgument ?? process.env.IPHONE_BRIDGE_CELLULAR_RELAY_URL ?? identity.relayUrl;
  if (!baseUrl) throw new Error("cellular relay URL is missing from the environment and identity file");
  const health = await jsonRequest(endpoint(baseUrl, "/healthz"));
  console.log(`relay_health=${health.status === "ok" ? "ok" : "failed"}`);
  const current = await status({ quiet: true });
  console.log(`identity_permissions=ok`);
  console.log(`paired=${current.paired}`);
  console.log(`revoked=${current.revoked}`);
  console.log(`host_online=${current.hostOnline}`);
  console.log(`device_online=${current.deviceOnline}`);
  if (!current.paired || current.revoked) throw new Error("cellular pairing is not usable");
  console.log("CELLULAR_DOCTOR_OK=1");
}

async function revoke() {
  const targetPath = identityPath();
  const identity = await loadHostIdentity(targetPath);
  const baseUrl = relayArgument ?? process.env.IPHONE_BRIDGE_CELLULAR_RELAY_URL ?? identity.relayUrl;
  if (!baseUrl) throw new Error("cellular relay URL is missing from the environment and identity file");
  await jsonRequest(endpoint(baseUrl, `/v1/devices/${identity.deviceId}/revoke`), {
    method: "POST",
    headers: { Authorization: `Bearer ${identity.authToken}` },
  });
  const revoked = { ...identity, revokedAt: new Date().toISOString() };
  delete revoked.authToken;
  delete revoked.peerSigningPublicKey;
  await saveHostIdentity(targetPath, revoked);
  console.log(`identity_file=${targetPath}`);
  console.log("CELLULAR_PAIRING_REVOKED=1");
}

async function main() {
  if (action === "pair") return await pair();
  if (action === "status") return await status();
  if (action === "doctor") return await doctor();
  if (action === "revoke") return await revoke();
  throw new Error("Usage: cellular-ops.mjs pair|status|doctor|revoke [https://relay.example]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
