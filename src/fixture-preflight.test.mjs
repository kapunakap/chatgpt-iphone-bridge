import assert from "node:assert/strict";
import test from "node:test";

import { chooseReachableFixture } from "./fixture-preflight.mjs";

function response(body, ok = true, status = 200) {
  return { ok, status, text: async () => body };
}

test("controlled fixture wins when its marker is reachable", async () => {
  const primary = { url: "http://192.168.1.19:4173/", selector: "#bridge-ready", marker: "READY" };
  const result = await chooseReachableFixture(primary, null, { fetch: async () => response("READY") });
  assert.equal(result.source, "controlled");
  assert.equal(result.fixture, primary);
});

test("explicit HTTPS fallback is selected and reported after controlled fixture failure", async () => {
  const primary = { url: "http://192.168.1.19:4173/", selector: "#bridge-ready", marker: "READY" };
  const fallback = { url: "https://example.com/", selector: "h1", marker: "Example Domain" };
  const result = await chooseReachableFixture(primary, fallback, {
    fetch: async (url) => (url.startsWith("http:") ? Promise.reject(new Error("LAN blocked")) : response("Example Domain")),
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.fixture, fallback);
  assert.match(result.primaryError, /LAN blocked/);
});

test("fixture preflight refuses silent or insecure fallback", async () => {
  const primary = { url: "http://lan/", selector: "#ready", marker: "READY" };
  const fetch = async () => Promise.reject(new Error("blocked"));
  await assert.rejects(chooseReachableFixture(primary, null, { fetch }), /no HTTPS fallback/);
  await assert.rejects(
    chooseReachableFixture(primary, { url: "http://fallback/", selector: "h1", marker: "ready" }, { fetch }),
    /must use HTTPS/,
  );
});
