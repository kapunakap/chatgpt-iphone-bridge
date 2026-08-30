import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  CELLULAR_MAX_MESSAGE_BYTES,
  ReplayCache,
  createSignedHello,
  deriveSessionKey,
  openPayload,
  sealPayload,
  validateFreshPayload,
  verifyPeerHello,
} from "./cellular-crypto.mjs";
import { createHostIdentity, validateHostIdentity } from "./cellular-identity.mjs";

function pairedIdentities() {
  const host = createHostIdentity("host");
  const device = createHostIdentity("device");
  const deviceId = randomUUID();
  return {
    deviceId,
    host: { ...host, deviceId, peerSigningPublicKey: device.signingPublicKey, authToken: Buffer.alloc(24, 1).toString("base64url") },
    device: { ...device, role: "device", deviceId, peerSigningPublicKey: host.signingPublicKey },
  };
}

test("cellular identity validation rejects unpaired and short credentials", () => {
  const identity = createHostIdentity();
  assert.doesNotThrow(() => validateHostIdentity(identity, { requirePairing: false }));
  assert.throws(() => validateHostIdentity(identity), /not paired/);
  assert.throws(
    () => validateHostIdentity({ ...identity, deviceId: randomUUID(), peerSigningPublicKey: identity.signingPublicKey, authToken: "AA" }),
    /auth token/,
  );
  assert.throws(
    () => validateHostIdentity({ ...identity, signingPublicKey: createHostIdentity().signingPublicKey }, { requirePairing: false }),
    /do not match/,
  );
});

test("signed ephemeral handshake derives the same session key", () => {
  const { host, device, deviceId } = pairedIdentities();
  const hostHandshake = createSignedHello(host, deviceId, "host");
  const deviceHandshake = createSignedHello(device, deviceId, "device");

  verifyPeerHello(deviceHandshake.hello, {
    deviceId,
    expectedRole: "device",
    peerSigningPublicKey: host.peerSigningPublicKey,
  });
  verifyPeerHello(hostHandshake.hello, {
    deviceId,
    expectedRole: "host",
    peerSigningPublicKey: device.peerSigningPublicKey,
  });

  const hostKey = deriveSessionKey({
    localEcdh: hostHandshake.ecdh,
    localHello: hostHandshake.hello,
    peerHello: deviceHandshake.hello,
  });
  const deviceKey = deriveSessionKey({
    localEcdh: deviceHandshake.ecdh,
    localHello: deviceHandshake.hello,
    peerHello: hostHandshake.hello,
  });
  assert.deepEqual(hostKey, deviceKey);

  const payload = {
    type: "request",
    messageId: randomUUID(),
    sentAt: Date.now(),
    expiresAt: Date.now() + 15_000,
    requestId: randomUUID(),
    command: "page.snapshot",
    args: {},
  };
  assert.deepEqual(openPayload(deviceKey, deviceId, sealPayload(hostKey, deviceId, payload)), payload);
});

test("handshake rejects tampering and wrong peers", () => {
  const { host, device, deviceId } = pairedIdentities();
  const { hello } = createSignedHello(device, deviceId, "device");
  assert.throws(
    () => verifyPeerHello({ ...hello, role: "host" }, { deviceId, expectedRole: "device", peerSigningPublicKey: host.peerSigningPublicKey }),
    /does not match/,
  );
  assert.throws(
    () => verifyPeerHello({ ...hello, nonce: Buffer.alloc(32, 9).toString("base64url") }, {
      deviceId,
      expectedRole: "device",
      peerSigningPublicKey: host.peerSigningPublicKey,
    }),
    /signature/,
  );
});

test("sealed payloads reject tampering, expiry, and replay", () => {
  const key = Buffer.alloc(32, 7);
  const deviceId = randomUUID();
  const now = 1_000_000;
  const payload = {
    type: "event",
    messageId: randomUUID(),
    sentAt: now,
    expiresAt: now + 1000,
  };
  const envelope = sealPayload(key, deviceId, payload);
  assert.throws(
    () => openPayload(key, deviceId, { ...envelope, ciphertext: Buffer.from("bad").toString("base64url") }),
  );

  const cache = new ReplayCache({ now: () => now });
  assert.equal(validateFreshPayload(payload, { now: () => now, replayCache: cache }), payload);
  assert.throws(() => validateFreshPayload(payload, { now: () => now, replayCache: cache }), /replay/);
  assert.throws(
    () => validateFreshPayload({ ...payload, messageId: randomUUID(), expiresAt: now - 1 }, { now: () => now }),
    /expired/,
  );
});

test("a 1.5 MiB JPEG response fits inside the encrypted relay frame cap", () => {
  const now = Date.now();
  const envelope = sealPayload(Buffer.alloc(32, 8), randomUUID(), {
    type: "response",
    messageId: randomUUID(),
    sentAt: now,
    expiresAt: now + 15_000,
    requestId: randomUUID(),
    ok: true,
    result: { mimeType: "image/jpeg", data: Buffer.alloc(1.5 * 1024 * 1024).toString("base64") },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= CELLULAR_MAX_MESSAGE_BYTES);
});
