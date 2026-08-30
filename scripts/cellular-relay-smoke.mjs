#!/usr/bin/env node

import { once } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import {
  ReplayCache,
  createSignedHello,
  deriveSessionKey,
  openPayload,
  sealPayload,
  validateFreshPayload,
  verifyPeerHello,
} from "../src/cellular-crypto.mjs";
import { createHostIdentity } from "../src/cellular-identity.mjs";
import { CellularRelayClient } from "../src/cellular-relay-client.mjs";

const base = new URL(process.argv[2] ?? process.env.IPHONE_BRIDGE_CELLULAR_RELAY_URL ?? "");
if (base.protocol !== "https:" && !(base.protocol === "http:" && new Set(["127.0.0.1", "localhost"]).has(base.hostname))) {
  throw new Error("Relay smoke requires HTTPS, or loopback HTTP for a local Wrangler runtime");
}

function endpoint(pathname) {
  const url = new URL(base);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url;
}

async function request(pathname, options = {}) {
  const response = await fetch(endpoint(pathname), {
    ...options,
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message ?? `relay returned HTTP ${response.status}`);
  return payload;
}

const host = createHostIdentity("relay-smoke-host");
const device = createHostIdentity("relay-smoke-device");
const started = await request("/v1/pair/start", {
  method: "POST",
  body: JSON.stringify({ hostPublicKey: host.signingPublicKey, alias: "relay-smoke" }),
});
const completed = await request(`/v1/devices/${started.deviceId}/pair/complete`, {
  method: "POST",
  body: JSON.stringify({ secret: started.secret, devicePublicKey: device.signingPublicKey }),
});
const collected = await request(`/v1/devices/${started.deviceId}/pair/status`, {
  method: "POST",
  body: JSON.stringify({ secret: started.secret }),
});
if (collected.state !== "paired" || collected.peerSigningPublicKey !== device.signingPublicKey) {
  throw new Error("relay pairing status was inconsistent");
}
const hostStatus = await request(`/v1/devices/${started.deviceId}/status`, {
  headers: { Authorization: `Bearer ${started.hostToken}`, "X-Bridge-Role": "host" },
});
const deviceStatus = await request(`/v1/devices/${started.deviceId}/status`, {
  headers: { Authorization: `Bearer ${completed.authToken}`, "X-Bridge-Role": "device" },
});
if (!hostStatus.paired || !deviceStatus.paired) throw new Error("relay role credentials did not authorize");

const pairedHost = {
  ...host,
  deviceId: started.deviceId,
  authToken: started.hostToken,
  peerSigningPublicKey: device.signingPublicKey,
};
const pairedDevice = {
  ...device,
  role: "device",
  deviceId: started.deviceId,
  authToken: completed.authToken,
  peerSigningPublicKey: host.signingPublicKey,
};
const deviceSocketUrl = new URL(base);
deviceSocketUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
deviceSocketUrl.pathname = `/v1/devices/${started.deviceId}/connect`;
deviceSocketUrl.search = "role=device";
const deviceSocket = new WebSocket(deviceSocketUrl, {
  headers: { Authorization: `Bearer ${completed.authToken}` },
  perMessageDeflate: false,
});
let deviceHandshake = null;
let deviceKey = null;
let peerKnown = false;
let peerOnline = false;
const deviceReplay = new ReplayCache();

function sendDeviceHello() {
  if (deviceSocket.readyState !== WebSocket.OPEN) return;
  deviceHandshake = createSignedHello(pairedDevice, started.deviceId, "device");
  deviceSocket.send(JSON.stringify(deviceHandshake.hello));
}

deviceSocket.on("message", (raw) => {
  const message = JSON.parse(Buffer.from(raw).toString("utf8"));
  if (message.type === "relay.peer") {
    const wasKnown = peerKnown;
    const wasOnline = peerOnline;
    peerKnown = true;
    peerOnline = message.online === true;
    if ((!wasKnown || !wasOnline) && peerOnline) sendDeviceHello();
    return;
  }
  if (message.type === "hello") {
    verifyPeerHello(message, {
      deviceId: started.deviceId,
      expectedRole: "host",
      peerSigningPublicKey: pairedDevice.peerSigningPublicKey,
    });
    if (!deviceHandshake) sendDeviceHello();
    deviceKey = deriveSessionKey({
      localEcdh: deviceHandshake.ecdh,
      localHello: deviceHandshake.hello,
      peerHello: message,
    });
    const now = Date.now();
    deviceSocket.send(
      JSON.stringify(
        sealPayload(deviceKey, started.deviceId, {
          type: "secure_ready",
          messageId: randomUUID(),
          sentAt: now,
          expiresAt: now + 30_000,
        }),
      ),
    );
    return;
  }
  if (message.type !== "sealed" || !deviceKey) return;
  const payload = validateFreshPayload(openPayload(deviceKey, started.deviceId, message), { replayCache: deviceReplay });
  if (payload.type !== "request") return;
  const now = Date.now();
  deviceSocket.send(
    JSON.stringify(
      sealPayload(deviceKey, started.deviceId, {
        type: "response",
        messageId: randomUUID(),
        sentAt: now,
        expiresAt: now + 15_000,
        requestId: payload.requestId,
        ok: true,
        result: { echo: payload.command },
      }),
    ),
  );
});

const hostClient = new CellularRelayClient({
  identity: pairedHost,
  relayUrl: base.href,
  allowInsecureLoopback: base.protocol === "http:",
});
hostClient.start();
let readyTimer;
await Promise.race([
  once(hostClient, "ready"),
  new Promise((_, reject) => {
    readyTimer = setTimeout(() => reject(new Error("relay WebSocket handshake timed out")), 15_000);
  }),
]);
clearTimeout(readyTimer);
const roundTrip = await hostClient.request("page.snapshot", {});
if (roundTrip.echo !== "page.snapshot") throw new Error("relay encrypted WebSocket round trip was inconsistent");
await hostClient.close();
deviceSocket.close(1000, "smoke complete");

await request(`/v1/devices/${started.deviceId}/revoke`, {
  method: "POST",
  headers: { Authorization: `Bearer ${started.hostToken}` },
});

console.log("CELLULAR_RELAY_SMOKE_OK=1");
