import assert from "node:assert/strict";
import test from "node:test";

import { createPairingPayload, pairingQrFilePath, relayHttpUrl } from "./cellular-ops.mjs";

test("cellular relay URLs require TLS and normalize WebSocket transport", () => {
  assert.equal(relayHttpUrl("wss://relay.example/").href, "https://relay.example/");
  assert.equal(relayHttpUrl("https://relay.example/base?secret=no").href, "https://relay.example/base");
  assert.throws(() => relayHttpUrl("http://relay.example"), /https or wss/);
});

test("pairing payload contains only the temporary bootstrap material", () => {
  const payload = JSON.parse(
    createPairingPayload("https://relay.example", {
      deviceId: "11111111-1111-4111-8111-111111111111",
      secret: "temporary-secret",
      expiresAt: 123456,
    }),
  );
  assert.deepEqual(payload, {
    version: 1,
    relayUrl: "https://relay.example",
    deviceId: "11111111-1111-4111-8111-111111111111",
    secret: "temporary-secret",
    expiresAt: 123456,
  });
  assert.equal("signingPrivateKey" in payload, false);
  assert.equal("authToken" in payload, false);
});

test("pairing QR fallback requires an absolute private output path", () => {
  assert.equal(pairingQrFilePath("/private/tmp/bridge-pairing.png"), "/private/tmp/bridge-pairing.png");
  assert.throws(() => pairingQrFilePath("bridge-pairing.png"), /absolute path/);
});
