#!/usr/bin/env node

import assert from "node:assert/strict";

import { openPayload } from "../src/cellular-crypto.mjs";

const vector = JSON.parse(process.env.SWIFT_CELLULAR_VECTOR ?? "null");
assert.ok(vector, "Swift cellular vector is missing");
const opened = openPayload(Buffer.from(vector.key, "base64url"), vector.deviceId, vector.envelope);
assert.deepEqual(opened, vector.payload, "Node could not decrypt the Swift AES-GCM vector");
console.log("CELLULAR_SWIFT_NODE_INTEROP_OK=1");
