import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import WebSocket from "ws";

import {
  ReplayCache,
  createSignedHello,
  deriveSessionKey,
  openPayload,
  sealPayload,
  validateFreshPayload,
  verifyPeerHello,
} from "./cellular-crypto.mjs";
import { createHostIdentity } from "./cellular-identity.mjs";
import { CellularRelayClient, relayWebSocketUrl } from "./cellular-relay-client.mjs";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.CONNECTING;
    this.peer = null;
  }
  send(value) {
    if (this.readyState !== WebSocket.OPEN) throw new Error("socket is not open");
    setImmediate(() => this.peer?.emit("message", Buffer.from(value)));
  }
  close(code = 1000, reason = "") {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSED;
    setImmediate(() => this.emit("close", code, Buffer.from(reason)));
  }
}

function pairSockets() {
  const host = new FakeSocket();
  const device = new FakeSocket();
  host.peer = device;
  device.peer = host;
  return { host, device };
}

function identities() {
  const hostIdentity = createHostIdentity("host");
  const deviceIdentity = createHostIdentity("device");
  const deviceId = randomUUID();
  return {
    deviceId,
    host: {
      ...hostIdentity,
      deviceId,
      peerSigningPublicKey: deviceIdentity.signingPublicKey,
      authToken: Buffer.alloc(32, 1).toString("base64url"),
    },
    device: { ...deviceIdentity, role: "device", deviceId, peerSigningPublicKey: hostIdentity.signingPublicKey },
  };
}

test("relay URL uses TLS WebSocket and strips unrelated path state", () => {
  const url = relayWebSocketUrl("https://relay.example/old?secret=no", "11111111-1111-4111-8111-111111111111");
  assert.equal(url.href, "wss://relay.example/v1/devices/11111111-1111-4111-8111-111111111111/connect?role=host&replace=1");
  assert.throws(() => relayWebSocketUrl("http://relay.example", randomUUID()), /https or wss/);
  assert.equal(
    relayWebSocketUrl("http://127.0.0.1:8799", "11111111-1111-4111-8111-111111111111", {
      allowInsecureLoopback: true,
    }).protocol,
    "ws:",
  );
});

test("relay client completes the authenticated handshake and request round trip", async () => {
  const { host, device, deviceId } = identities();
  const sockets = pairSockets();
  let deviceHandshake = null;
  let sessionKey = null;
  const replay = new ReplayCache();

  sockets.device.on("message", (raw) => {
    const message = JSON.parse(Buffer.from(raw).toString("utf8"));
    if (message.type === "hello") {
      verifyPeerHello(message, {
        deviceId,
        expectedRole: "host",
        peerSigningPublicKey: device.peerSigningPublicKey,
      });
      deviceHandshake = createSignedHello(device, deviceId, "device");
      sessionKey = deriveSessionKey({
        localEcdh: deviceHandshake.ecdh,
        localHello: deviceHandshake.hello,
        peerHello: message,
      });
      sockets.device.send(JSON.stringify(deviceHandshake.hello));
      const now = Date.now();
      sockets.device.send(
        JSON.stringify(
          sealPayload(sessionKey, deviceId, {
            type: "secure_ready",
            messageId: randomUUID(),
            sentAt: now,
            expiresAt: now + 30_000,
          }),
        ),
      );
      return;
    }
    if (message.type !== "sealed" || !sessionKey) return;
    const payload = validateFreshPayload(openPayload(sessionKey, deviceId, message), { replayCache: replay });
    if (payload.type !== "request") return;
    const now = Date.now();
    sockets.device.send(
      JSON.stringify(
        sealPayload(sessionKey, deviceId, {
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

  const client = new CellularRelayClient({
    identity: host,
    relayUrl: "https://relay.example",
    reconnectDelaysMs: [1000],
    webSocketFactory: (_url, options) => {
      assert.match(options.headers.Authorization, /^Bearer /);
      setImmediate(() => {
        sockets.host.readyState = WebSocket.OPEN;
        sockets.device.readyState = WebSocket.OPEN;
        sockets.host.emit("open");
        sockets.host.emit("message", Buffer.from(JSON.stringify({ v: 1, type: "relay.peer", online: true })));
      });
      return sockets.host;
    },
  });
  client.start();
  await once(client, "ready");
  assert.deepEqual(client.status(), { relayConnected: true, deviceOnline: true, secureReady: true });
  assert.deepEqual(await client.request("page.snapshot", {}), { echo: "page.snapshot" });
  await client.close();
});
