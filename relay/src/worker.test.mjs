import assert from "node:assert/strict";
import test from "node:test";

import { PAIRING_RATE_LIMIT } from "./core.mjs";
import worker, { DeviceRelay, PairRateLimiter } from "./worker.mjs";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }
  async deleteAll() {
    this.values.clear();
  }
  async setAlarm(value) {
    this.values.set("__alarm", value);
  }
  async deleteAlarm() {
    this.values.delete("__alarm");
  }
}

class FakeContext {
  constructor() {
    this.storage = new MemoryStorage();
    this.sockets = { host: [], device: [] };
  }
  getWebSockets(tag) {
    if (!tag) return [...this.sockets.host, ...this.sockets.device];
    return this.sockets[tag] ?? [];
  }
}

class FakeNamespace {
  constructor(Type) {
    this.Type = Type;
    this.instances = new Map();
  }
  idFromName(name) {
    return name;
  }
  get(id) {
    if (!this.instances.has(id)) this.instances.set(id, new this.Type(new FakeContext()));
    return this.instances.get(id);
  }
}

function key(seed) {
  return Buffer.concat([Buffer.from([4]), Buffer.alloc(64, seed)]).toString("base64url");
}

function request(path, { method = "POST", body, token, role } = {}) {
  const headers = new Headers({ "X-Relay-Internal": "1" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (role) headers.set("X-Bridge-Role", role);
  return new Request(`https://relay.invalid${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function body(response) {
  return await response.json();
}

async function pair(relay, { expiresAt = Date.now() + 300_000 } = {}) {
  const deviceId = crypto.randomUUID();
  const secret = Buffer.alloc(24, 3).toString("base64url");
  const hostToken = Buffer.alloc(32, 4).toString("base64url");
  const started = await relay.fetch(
    request("/pair/start", {
      body: {
        deviceId,
        secret,
        hostTokenHash: await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hostToken)).then((value) =>
          [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")),
        expiresAt,
        hostPublicKey: key(1),
        alias: "phone",
      },
    }),
  );
  assert.equal(started.status, 201);
  return { deviceId, secret, hostToken };
}

test("public Worker routes a complete one-time pairing without storing raw credentials", async () => {
  const env = {
    DEVICES: new FakeNamespace(DeviceRelay),
    PAIR_RATES: new FakeNamespace(PairRateLimiter),
  };
  const startedResponse = await worker.fetch(
    new Request("https://relay.example/v1/pair/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" },
      body: JSON.stringify({ hostPublicKey: key(1), alias: "phone" }),
    }),
    env,
  );
  assert.equal(startedResponse.status, 201);
  const started = await body(startedResponse);
  assert.ok(started.hostToken.length >= 32);
  assert.ok(started.secret.length >= 32);

  const completedResponse = await worker.fetch(
    new Request(`https://relay.example/v1/devices/${started.deviceId}/pair/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: started.secret, devicePublicKey: key(2) }),
    }),
    env,
  );
  assert.equal(completedResponse.status, 200);
  const completed = await body(completedResponse);

  const collectedResponse = await worker.fetch(
    new Request(`https://relay.example/v1/devices/${started.deviceId}/pair/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: started.secret }),
    }),
    env,
  );
  assert.equal(collectedResponse.status, 200);
  const collected = await body(collectedResponse);
  assert.equal(collected.peerSigningPublicKey, key(2));

  const stored = await env.DEVICES.instances.get(started.deviceId).storage.get("pairing");
  assert.notEqual(stored.hostTokenHash, started.hostToken);
  assert.notEqual(stored.deviceTokenHash, completed.authToken);
  assert.equal(stored.secretHash, undefined);
  assert.equal(stored.collectionExpiresAt, undefined);

  const unauthorized = await worker.fetch(
    new Request(`https://relay.example/v1/devices/${started.deviceId}/status`, {
      headers: { Authorization: `Bearer ${Buffer.alloc(32, 9).toString("base64url")}` },
    }),
    env,
  );
  assert.equal(unauthorized.status, 401);
});

test("pairing completes once and exposes each role credential only to that role", async () => {
  const ctx = new FakeContext();
  const relay = new DeviceRelay(ctx);
  const { deviceId, secret, hostToken } = await pair(relay);

  const wrong = await relay.fetch(request("/device/pair/complete", { body: { secret: "wrong", devicePublicKey: key(2) } }));
  assert.equal(wrong.status, 401);

  const completed = await relay.fetch(
    request("/device/pair/complete", { body: { secret, devicePublicKey: key(2) } }),
  );
  assert.equal(completed.status, 200);
  const device = await body(completed);
  assert.equal(device.deviceId, deviceId);
  assert.equal(device.peerSigningPublicKey, key(1));
  assert.ok(device.authToken.length >= 32);

  const collected = await relay.fetch(request("/device/pair/status", { body: { secret } }));
  const host = await body(collected);
  assert.equal(host.state, "paired");
  assert.equal(host.peerSigningPublicKey, key(2));
  assert.equal(host.authToken, undefined);

  const second = await relay.fetch(request("/device/pair/status", { body: { secret } }));
  assert.equal(second.status, 401);

  const stored = await ctx.storage.get("pairing");
  assert.equal(stored.secretHash, undefined);
  assert.equal(JSON.stringify(stored).includes("https://"), false);
  assert.equal(JSON.stringify(stored).includes("screenshot"), false);

  const hostStatus = await relay.fetch(request("/device/status", { method: "GET", token: hostToken }));
  assert.equal(hostStatus.status, 200);
  const deviceStatus = await relay.fetch(
    request("/device/status", { method: "GET", token: device.authToken, role: "device" }),
  );
  assert.equal(deviceStatus.status, 200);

  const revoked = await relay.fetch(request("/device/revoke", { token: hostToken }));
  assert.deepEqual(await body(revoked), { revoked: true });
  const after = await ctx.storage.get("pairing");
  assert.equal(after.revoked, true);
  assert.equal(after.hostTokenHash, undefined);
  assert.equal(after.deviceTokenHash, undefined);
});

test("expired pairing fails closed and removes pending credentials", async () => {
  const ctx = new FakeContext();
  const relay = new DeviceRelay(ctx);
  const { secret } = await pair(relay, { expiresAt: Date.now() - 1 });
  const response = await relay.fetch(
    request("/device/pair/complete", { body: { secret, devicePublicKey: key(2) } }),
  );
  assert.equal(response.status, 410);
  assert.equal(await ctx.storage.get("pairing"), undefined);
});

test("rate limiter allows ten starts per five-minute bucket and then fails", async () => {
  const ctx = new FakeContext();
  const limiter = new PairRateLimiter(ctx);
  for (let count = 0; count < PAIRING_RATE_LIMIT; count += 1) {
    const response = await limiter.fetch(request("/check"));
    assert.equal(response.status, 200);
  }
  const blocked = await limiter.fetch(request("/check"));
  assert.equal(blocked.status, 429);
});

test("hibernated socket attachment restores routing without in-memory content", async () => {
  const ctx = new FakeContext();
  const received = [];
  const host = { deserializeAttachment: () => ({ role: "host" }), close: () => {} };
  const device = { send: (message) => received.push(message), close: () => {} };
  ctx.sockets.host.push(host);
  ctx.sockets.device.push(device);
  const restoredRelay = new DeviceRelay(ctx);
  const ciphertext = JSON.stringify({ v: 1, type: "sealed", ciphertext: "opaque" });
  await restoredRelay.webSocketMessage(host, ciphertext);
  assert.deepEqual(received, [ciphertext]);
});

test("oversized WebSocket messages close the sender and are not forwarded", async () => {
  const ctx = new FakeContext();
  const received = [];
  let closeCode = null;
  const host = { deserializeAttachment: () => ({ role: "host" }), close: (code) => (closeCode = code) };
  ctx.sockets.device.push({ send: (message) => received.push(message) });
  const relay = new DeviceRelay(ctx);
  await relay.webSocketMessage(host, new Uint8Array(3 * 1024 * 1024 + 1).buffer);
  assert.equal(closeCode, 1009);
  assert.deepEqual(received, []);
});
