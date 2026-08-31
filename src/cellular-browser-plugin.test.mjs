import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { CellularBrowserPlugin } from "./cellular-browser-plugin.mjs";

class FakeClient extends EventEmitter {
  constructor({ ready = false, request } = {}) {
    super();
    this.identity = { alias: "test-phone" };
    this.state = { relayConnected: true, deviceOnline: ready, secureReady: ready };
    this.requests = [];
    this.requestHandler = request ?? (async () => ({}));
    this.started = false;
    this.closed = false;
  }

  status() {
    return { ...this.state };
  }

  start() {
    this.started = true;
  }

  async request(command, args, options) {
    this.requests.push({ command, args, options });
    return await this.requestHandler(command, args, options);
  }

  async close() {
    this.closed = true;
  }

  becomeReady() {
    this.state = { relayConnected: true, deviceOnline: true, secureReady: true };
    this.emit("ready", this.status());
  }
}

function setup(client, options = {}) {
  const tools = new Map();
  const lease = { acquired: 0, released: 0 };
  const plugin = new CellularBrowserPlugin({
    client,
    makeId: () => "11111111-1111-4111-8111-111111111111",
    lease: {
      acquire: async () => {
        lease.acquired += 1;
        return "lease-token";
      },
      release: async () => {
        lease.released += 1;
      },
    },
    ...options,
  });
  plugin.register({ addTool: (tool) => tools.set(tool.name, tool) });
  return { plugin, tools, lease };
}

function payload(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("cellular plugin exposes seven namespaced tools", () => {
  const { tools } = setup(new FakeClient());
  assert.deepEqual([...tools.keys()].sort(), [
    "iphone_browser_device_status",
    "iphone_browser_element",
    "iphone_browser_find",
    "iphone_browser_navigate",
    "iphone_browser_screenshot",
    "iphone_browser_session",
    "iphone_browser_snapshot",
  ]);
});

test("device status exposes the explicit host, device, and secure readiness gate", async () => {
  const { tools } = setup(new FakeClient({ ready: true }));
  const status = payload(await tools.get("iphone_browser_device_status").execute({}));
  assert.equal(status.hostOnline, true);
  assert.equal(status.deviceOnline, true);
  assert.equal(status.secureReady, true);
});

test("session start is non-blocking, waits for device, and becomes ready after approval", async () => {
  const sessionId = randomUUID();
  const client = new FakeClient({
    request: async (command) => {
      if (command === "session.start") return { state: "ready", sessionId, currentUrl: "https://example.test/" };
      if (command === "session.stop") return { state: "closed" };
      throw new Error(`unexpected command: ${command}`);
    },
  });
  const { plugin, tools, lease } = setup(client);
  const started = await tools.get("iphone_browser_session").execute({
    action: "start",
    initialUrl: "https://example.test/",
    allowedOrigins: ["https://example.test"],
  });
  assert.equal(payload(started).state, "awaiting_device");
  assert.equal(lease.acquired, 1);

  client.becomeReady();
  await settle();
  const status = await tools.get("iphone_browser_session").execute({ action: "status" });
  assert.equal(payload(status).state, "ready");
  assert.equal(payload(status).sessionId, sessionId);
  assert.equal(lease.released, 0);

  await tools.get("iphone_browser_session").execute({ action: "stop", sessionId });
  assert.equal(lease.released, 1);
  assert.equal(client.requests.at(-1).command, "session.stop");
  await plugin.shutdown();
});

test("navigation enforces approved HTTPS origins before sending a command", async () => {
  const sessionId = randomUUID();
  const client = new FakeClient({
    ready: true,
    request: async (command) =>
      command === "session.start" ? { state: "ready", sessionId } : { currentUrl: "https://example.test/next" },
  });
  const { tools } = setup(client);
  await tools.get("iphone_browser_session").execute({
    action: "start",
    initialUrl: "https://example.test/",
    allowedOrigins: ["https://example.test"],
  });
  await settle();

  const blocked = await tools.get("iphone_browser_navigate").execute({
    sessionId,
    action: "open",
    url: "https://other.test/",
  });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.error.code, "ORIGIN_NOT_APPROVED");

  const allowed = await tools.get("iphone_browser_navigate").execute({
    sessionId,
    action: "open",
    url: "https://example.test/next",
  });
  assert.equal(allowed.isError, undefined);
  assert.equal(client.requests.at(-1).command, "page.navigate");
});

test("cancelling a pending approval tells the iPhone and cannot create an orphan session", async () => {
  let finishApproval;
  const pendingApproval = new Promise((resolve) => {
    finishApproval = resolve;
  });
  const client = new FakeClient({
    ready: true,
    request: async (command) => {
      if (command === "session.start") return await pendingApproval;
      if (command === "session.cancel") {
        finishApproval({ state: "rejected" });
        return { state: "cancelled" };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });
  const { plugin, tools, lease } = setup(client);
  await tools.get("iphone_browser_session").execute({
    action: "start",
    initialUrl: "https://example.test/",
    allowedOrigins: ["https://example.test"],
  });
  await settle();
  const delivering = payload(await tools.get("iphone_browser_session").execute({ action: "status" }));
  assert.equal(delivering.state, "requesting_approval");
  assert.equal(delivering.userActionRequired, false);
  assert.match(delivering.nextAction, /has not yet acknowledged/);
  client.emit("event", "session.approval_pending", { operationId: delivering.operationId });
  await settle();
  const waiting = payload(await tools.get("iphone_browser_session").execute({ action: "status" }));
  assert.equal(waiting.state, "awaiting_approval");
  assert.equal(waiting.userActionRequired, true);
  assert.match(waiting.nextAction, /Do not cancel unless the user explicitly asks/);
  assert.ok(Date.parse(waiting.approvalExpiresAt) > Date.parse(waiting.startedAt));
  const cancelled = await tools.get("iphone_browser_session").execute({ action: "cancel" });
  assert.equal(payload(cancelled).state, "cancelled");
  assert.equal(client.requests.some((request) => request.command === "session.cancel"), true);
  assert.equal(plugin.operation.sessionId, null);
  assert.equal(lease.released, 1);
});

test("snapshot and screenshot enforce response bounds", async () => {
  const sessionId = randomUUID();
  const client = new FakeClient({
    ready: true,
    request: async (command) => {
      if (command === "session.start") return { state: "ready", sessionId };
      if (command === "page.snapshot") return { text: "x".repeat(40 * 1024) };
      if (command === "page.screenshot") {
        return { mimeType: "image/jpeg", data: Buffer.alloc(1.6 * 1024 * 1024).toString("base64") };
      }
      return {};
    },
  });
  const { tools } = setup(client);
  await tools.get("iphone_browser_session").execute({
    action: "start",
    initialUrl: "https://example.test/",
    allowedOrigins: ["https://example.test"],
  });
  await settle();

  const snapshot = await tools.get("iphone_browser_snapshot").execute({ sessionId });
  assert.equal(snapshot.isError, true);
  assert.equal(snapshot.structuredContent.error.code, "RESPONSE_TOO_LARGE");
  const screenshot = await tools.get("iphone_browser_screenshot").execute({ sessionId });
  assert.equal(screenshot.isError, true);
  assert.equal(screenshot.structuredContent.error.code, "RESPONSE_TOO_LARGE");
});

test("foreground disconnect enters grace and session close releases the lease", async () => {
  const sessionId = randomUUID();
  const client = new FakeClient({ ready: true, request: async () => ({ state: "ready", sessionId }) });
  const { plugin, tools, lease } = setup(client, { reconnectGraceMs: 1000 });
  await tools.get("iphone_browser_session").execute({
    action: "start",
    initialUrl: "https://example.test/",
    allowedOrigins: ["https://example.test"],
  });
  await settle();
  client.state.secureReady = false;
  client.emit("interrupted", client.status());
  assert.equal(plugin.operation.state, "interrupted");
  client.emit("event", "session.closed", { sessionId });
  await settle();
  assert.equal(plugin.operation.state, "closed");
  assert.equal(lease.released, 1);
});

test("terminal cellular operation metadata expires after the retention window", async () => {
  const sessionId = randomUUID();
  const client = new FakeClient({
    ready: true,
    request: async (command) =>
      command === "session.start" ? { state: "ready", sessionId } : { state: "closed" },
  });
  const { plugin, tools } = setup(client, { terminalRetentionMs: 5 });
  await tools.get("iphone_browser_session").execute({
    action: "start",
    initialUrl: "https://example.test/",
    allowedOrigins: ["https://example.test"],
  });
  await settle();
  await tools.get("iphone_browser_session").execute({ action: "stop", sessionId });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(plugin.operation, null);
});
