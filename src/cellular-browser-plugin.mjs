import { randomUUID } from "node:crypto";
import { z } from "zod";

import { CellularRelayClient } from "./cellular-relay-client.mjs";
import { DeviceLease } from "./device-lease.mjs";
import { loadHostIdentity } from "./cellular-identity.mjs";

const SESSION_APPROVAL_TIMEOUT_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 15_000;
const RECONNECT_GRACE_MS = 30_000;
const MAX_SNAPSHOT_BYTES = 32 * 1024;
const MAX_SCREENSHOT_BYTES = 1.5 * 1024 * 1024;
const TERMINAL_STATES = new Set(["cancelled", "closed", "failed", "rejected", "timed_out"]);

const emptySchema = z.object({});
const sessionSchema = z.object({
  action: z.enum(["start", "status", "cancel", "stop"]),
  operationId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  initialUrl: z.string().url().optional(),
  allowedOrigins: z.array(z.string().url()).max(10).optional(),
});
const navigateSchema = z.object({
  sessionId: z.string().uuid(),
  action: z.enum(["open", "back", "forward", "reload"]),
  url: z.string().url().optional(),
});
const findSchema = z.object({
  sessionId: z.string().uuid(),
  strategy: z.enum(["css", "text", "role"]),
  selector: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(20).optional(),
});
const elementSchema = z.object({
  sessionId: z.string().uuid(),
  action: z.enum(["tap", "type", "clear", "getText", "scrollIntoView", "press", "drag"]),
  elementId: z.string().min(1).max(200),
  text: z.string().max(16 * 1024).optional(),
  durationMs: z.number().int().min(50).max(10_000).optional(),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  endX: z.number().min(0).max(1).optional(),
  endY: z.number().min(0).max(1).optional(),
});
const snapshotSchema = z.object({
  sessionId: z.string().uuid(),
  maxNodes: z.number().int().min(1).max(200).optional(),
});
const screenshotSchema = z.object({
  sessionId: z.string().uuid(),
  maxWidth: z.number().int().min(320).max(1200).optional(),
});

function successContent(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorContent(error, fallbackCode = "CELLULAR_BROWSER_ERROR") {
  const message = error instanceof Error ? error.message : String(error);
  const code = error?.code ?? fallbackCode;
  return {
    isError: true,
    content: [{ type: "text", text: `iPhone cellular browser error: ${message}` }],
    structuredContent: { error: { code, message, retryable: error?.retryable === true } },
  };
}

function validateHttpsUrl(raw, label) {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`${label} must use https`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  return url;
}

function normalizeOrigins(initialUrl, allowedOrigins) {
  const initial = validateHttpsUrl(initialUrl, "initialUrl");
  const values = allowedOrigins?.length ? allowedOrigins : [initial.origin];
  const normalized = [...new Set(values.map((value) => validateHttpsUrl(value, "allowed origin").origin))];
  if (!normalized.includes(initial.origin)) throw new Error("allowedOrigins must include the initial URL origin");
  if (normalized.length > 10) throw new Error("at most 10 allowed origins may be approved");
  return { initialUrl: initial.href, allowedOrigins: normalized };
}

function publicOperation(operation, now) {
  if (!operation) return null;
  const payload = {
    operationId: operation.id,
    state: operation.state,
    stage: operation.stage,
    startedAt: new Date(operation.startedAt).toISOString(),
    updatedAt: new Date(operation.updatedAt).toISOString(),
    elapsedMs: Math.max(0, now() - operation.startedAt),
    cleanupPending: operation.cleanupPending,
  };
  if (operation.sessionId) payload.sessionId = operation.sessionId;
  if (operation.result) payload.result = operation.result;
  if (operation.error) payload.error = operation.error;
  if (["awaiting_device", "requesting_approval", "awaiting_approval"].includes(operation.state)) {
    payload.approvalExpiresAt = new Date(operation.approvalExpiresAt).toISOString();
  }
  if (operation.state === "requesting_approval") {
    payload.userActionRequired = false;
    payload.nextAction =
      "Keep polling this operationId. The encrypted request was sent, but the iPhone has not yet acknowledged that its native approval UI is visible. Do not claim approval is live and do not cancel.";
  }
  if (operation.state === "awaiting_approval") {
    payload.userActionRequired = true;
    payload.nextAction =
      "Ask the user to open Bridge Browser and tap Approve, then poll status with this operationId. Do not cancel unless the user explicitly asks or the approval timeout expires.";
  }
  return payload;
}

function requireSession(plugin, sessionId) {
  const operation = plugin.operation;
  if (!operation || !["ready", "interrupted"].includes(operation.state) || operation.sessionId !== sessionId) {
    const error = new Error("cellular browser session is not active");
    error.code = "SESSION_NOT_ACTIVE";
    throw error;
  }
  if (operation.state === "interrupted" || !plugin.client.status().secureReady) {
    const error = new Error("cellular browser session is reconnecting");
    error.code = "SESSION_INTERRUPTED";
    error.retryable = true;
    throw error;
  }
  return operation;
}

export class CellularBrowserPlugin {
  constructor(options) {
    if (!options?.client) throw new Error("cellular relay client is required");
    this.name = "openai-cellular-iphone-browser";
    this.version = "0.2.0-beta.2";
    this.client = options.client;
    this.alias = options.alias ?? options.client.identity?.alias ?? "remote-iphone";
    this.lease = options.lease ?? new DeviceLease();
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? randomUUID;
    this.schedule = options.schedule ?? queueMicrotask;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? SESSION_APPROVAL_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.reconnectGraceMs = options.reconnectGraceMs ?? RECONNECT_GRACE_MS;
    this.terminalRetentionMs = options.terminalRetentionMs ?? 24 * 60 * 60_000;
    this.operation = null;
    this.terminalTimer = null;
    this.shuttingDown = false;
    this.listenersAttached = false;
    this.attachListeners();
  }

  register(registry) {
    registry.addTool({
      name: "iphone_browser_device_status",
      description:
        "Read redacted connection and session state for the paired cellular Bridge Browser. This is the authoritative device gate for Bridge Browser and does not require USB; never call select_device or appium_* tools to validate this cellular path.",
      parameters: emptySchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: async (args) => this.execute(emptySchema, args, () => this.deviceStatus()),
    });
    registry.addTool({
      name: "iphone_browser_session",
      description:
        "Start, poll, cancel, or stop an approved foreground cellular Bridge Browser session without USB. For Bridge Browser, use only iphone_browser_* tools and never call select_device or appium_* tools. When start or status returns awaiting_approval, ask the user to tap Approve and keep polling with the operationId. Never cancel merely to clean up or prove delivery; cancel only when the user asks or the five-minute approval timeout expires.",
      parameters: sessionSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      execute: async (args) => this.execute(sessionSchema, args, (parsed) => this.session(parsed)),
    });
    registry.addTool({
      name: "iphone_browser_navigate",
      description: "Open an approved HTTPS URL, go back or forward, or reload the cellular browser.",
      parameters: navigateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      execute: async (args) => this.execute(navigateSchema, args, (parsed) => this.navigate(parsed)),
    });
    registry.addTool({
      name: "iphone_browser_find",
      description: "Find up to 20 DOM elements by CSS selector, visible text, or ARIA role.",
      parameters: findSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: async (args) => this.execute(findSchema, args, (parsed) => this.command("element.find", parsed)),
    });
    registry.addTool({
      name: "iphone_browser_element",
      description:
        "Tap, type, clear, read, scroll, press-and-hold, or drag within an element returned by iphone_browser_find. For press/drag, durationMs is bounded to 10 seconds and x/y/endX/endY are normalized element coordinates from 0 to 1. This supports touch controls without arbitrary JavaScript.",
      parameters: elementSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      execute: async (args) => this.execute(elementSchema, args, (parsed) => this.element(parsed)),
    });
    registry.addTool({
      name: "iphone_browser_snapshot",
      description: "Return a bounded semantic DOM snapshot from the approved cellular browser page.",
      parameters: snapshotSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: async (args) => this.execute(snapshotSchema, args, (parsed) => this.snapshot(parsed)),
    });
    registry.addTool({
      name: "iphone_browser_screenshot",
      description: "Capture a bounded JPEG screenshot of the approved cellular browser page.",
      parameters: screenshotSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: async (args) => this.execute(screenshotSchema, args, (parsed) => this.screenshot(parsed)),
    });
  }

  async initialize() {
    this.client.start();
  }

  async execute(schema, rawArgs, action) {
    try {
      const parsed = schema.parse(rawArgs ?? {});
      const payload = await action(parsed);
      if (payload?.content) return payload;
      return successContent(payload);
    } catch (error) {
      return errorContent(error, error instanceof z.ZodError ? "INVALID_ARGUMENTS" : "CELLULAR_BROWSER_ERROR");
    }
  }

  attachListeners() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    this.client.on("ready", () => void this.onReady());
    this.client.on("interrupted", () => this.onInterrupted());
    this.client.on("event", (name, data) => void this.onEvent(name, data));
  }

  deviceStatus() {
    const status = this.client.status();
    return {
      configured: true,
      paired: true,
      alias: this.alias,
      hostOnline: status.relayConnected === true,
      ...status,
      operation: publicOperation(this.operation, this.now),
    };
  }

  async session(args) {
    if (args.action === "start") return await this.startSession(args);
    if (args.action === "status") return this.sessionStatus(args.operationId);
    if (args.action === "cancel") return await this.closeSession("cancelled", args);
    return await this.closeSession("closed", args);
  }

  async startSession(args) {
    if (this.shuttingDown) throw Object.assign(new Error("bridge shutdown is in progress"), { code: "SHUTTING_DOWN" });
    if (!args.initialUrl) throw new Error("initialUrl is required for session start");
    if (!args.allowedOrigins?.length) throw new Error("allowedOrigins is required for session start");
    const normalized = normalizeOrigins(args.initialUrl, args.allowedOrigins);
    if (this.operation && !["closed", "cancelled", "rejected", "timed_out", "failed"].includes(this.operation.state)) {
      if (
        this.operation.initialUrl === normalized.initialUrl &&
        JSON.stringify(this.operation.allowedOrigins) === JSON.stringify(normalized.allowedOrigins)
      ) {
        return publicOperation(this.operation, this.now);
      }
      throw Object.assign(new Error("another cellular browser operation is active"), { code: "OPERATION_IN_PROGRESS" });
    }

    if (this.terminalTimer) clearTimeout(this.terminalTimer);
    this.terminalTimer = null;

    const leaseToken = await this.lease.acquire("cellular_browser");
    const startedAt = this.now();
    const operation = {
      id: this.makeId(),
      state: this.client.status().secureReady ? "requesting_approval" : "awaiting_device",
      stage: this.client.status().secureReady ? "approval_delivery" : "device_connection",
      startedAt,
      updatedAt: startedAt,
      approvalExpiresAt: startedAt + this.approvalTimeoutMs,
      cleanupPending: false,
      initialUrl: normalized.initialUrl,
      allowedOrigins: normalized.allowedOrigins,
      sessionId: null,
      result: null,
      error: null,
      leaseToken,
      approvalPromise: null,
      approvalTimer: null,
      reconnectTimer: null,
    };
    operation.approvalTimer = setTimeout(() => void this.timeoutOperation(operation), this.approvalTimeoutMs);
    operation.approvalTimer.unref?.();
    this.operation = operation;
    if (this.client.status().secureReady) this.schedule(() => void this.requestApproval(operation));
    return publicOperation(operation, this.now);
  }

  sessionStatus(operationId) {
    if (!this.operation) throw Object.assign(new Error("no cellular browser operation exists"), { code: "UNKNOWN_OPERATION" });
    if (operationId && operationId !== this.operation.id) {
      throw Object.assign(new Error(`unknown operationId: ${operationId}`), { code: "UNKNOWN_OPERATION" });
    }
    return publicOperation(this.operation, this.now);
  }

  async requestApproval(operation) {
    if (
      this.operation !== operation ||
      operation.approvalPromise ||
      !["awaiting_device", "requesting_approval"].includes(operation.state)
    ) return;
    operation.state = "requesting_approval";
    operation.stage = "approval_delivery";
    operation.updatedAt = this.now();
    const remainingMs = Math.max(1, operation.startedAt + this.approvalTimeoutMs - this.now());
    operation.approvalPromise = this.client.request(
      "session.start",
      { operationId: operation.id, initialUrl: operation.initialUrl, allowedOrigins: operation.allowedOrigins },
      { timeoutMs: remainingMs },
    );
    try {
      const result = await operation.approvalPromise;
      if (
        this.operation !== operation ||
        !["requesting_approval", "awaiting_approval", "awaiting_device"].includes(operation.state)
      ) return;
      if (result.state === "rejected") {
        operation.state = "rejected";
        operation.stage = "finished";
        operation.error = { code: "USER_REJECTED", message: "The iPhone user rejected the session", retryable: false };
        await this.release(operation);
        return;
      }
      if (result.state !== "ready" || typeof result.sessionId !== "string") {
        throw new Error("iPhone returned an invalid session approval result");
      }
      operation.sessionId = result.sessionId;
      operation.result = {
        sessionId: result.sessionId,
        currentUrl: result.currentUrl ?? operation.initialUrl,
        allowedOrigins: operation.allowedOrigins,
      };
      operation.state = "ready";
      operation.stage = "active";
      operation.updatedAt = this.now();
      if (operation.approvalTimer) clearTimeout(operation.approvalTimer);
      operation.approvalTimer = null;
    } catch (error) {
      if (this.operation !== operation || ["cancelled", "closed", "timed_out"].includes(operation.state)) return;
      if (error?.code === "DEVICE_OFFLINE" || error?.code === "RELAY_DISCONNECTED") {
        operation.approvalPromise = null;
        operation.state = "awaiting_device";
        operation.stage = "device_connection";
        operation.updatedAt = this.now();
        return;
      }
      if (error?.code === "COMMAND_TIMEOUT") {
        await this.cancelRemoteApproval(operation);
        operation.state = "timed_out";
        operation.stage = "finished";
        operation.error = { code: "APPROVAL_TIMEOUT", message: "The iPhone did not approve within five minutes", retryable: true };
        operation.updatedAt = this.now();
        await this.release(operation);
        return;
      }
      operation.state = "failed";
      operation.stage = "finished";
      operation.error = { code: error?.code ?? "SESSION_START_FAILED", message: error.message, retryable: error?.retryable === true };
      await this.release(operation);
    } finally {
      if (this.operation === operation && operation.state !== "awaiting_approval") operation.approvalPromise = null;
    }
  }

  async timeoutOperation(operation) {
    if (
      this.operation !== operation ||
      !["awaiting_device", "requesting_approval", "awaiting_approval"].includes(operation.state)
    ) return;
    operation.state = "timed_out";
    operation.stage = "finished";
    operation.error = { code: "APPROVAL_TIMEOUT", message: "The iPhone did not approve within five minutes", retryable: true };
    operation.updatedAt = this.now();
    await this.cancelRemoteApproval(operation);
    await this.release(operation);
  }

  async closeSession(finalState, args = {}) {
    const operation = this.operation;
    if (!operation) throw Object.assign(new Error("no cellular browser operation exists"), { code: "UNKNOWN_OPERATION" });
    if (args.operationId && args.operationId !== operation.id) {
      throw Object.assign(new Error(`unknown operationId: ${args.operationId}`), { code: "UNKNOWN_OPERATION" });
    }
    if (args.sessionId && args.sessionId !== operation.sessionId) {
      throw Object.assign(new Error(`unknown sessionId: ${args.sessionId}`), { code: "SESSION_NOT_ACTIVE" });
    }
    const previousState = operation.state;
    operation.state = "cancelling";
    operation.cleanupPending = true;
    operation.stage = "cleanup";
    operation.updatedAt = this.now();
    if (!operation.sessionId && ["requesting_approval", "awaiting_approval"].includes(previousState)) {
      await this.cancelRemoteApproval(operation);
    }
    if (operation.sessionId && this.client.status().secureReady) {
      try {
        await this.client.request("session.stop", { sessionId: operation.sessionId }, { timeoutMs: this.commandTimeoutMs });
      } catch (error) {
        if (!new Set(["DEVICE_OFFLINE", "RELAY_DISCONNECTED", "COMMAND_TIMEOUT"]).has(error?.code)) throw error;
      }
    }
    operation.state = finalState;
    operation.stage = "finished";
    operation.sessionId = null;
    operation.cleanupPending = false;
    operation.updatedAt = this.now();
    await this.release(operation);
    return publicOperation(operation, this.now);
  }

  async cancelRemoteApproval(operation) {
    if (!this.client.status().secureReady) return;
    try {
      await this.client.request("session.cancel", { operationId: operation.id }, { timeoutMs: this.commandTimeoutMs });
    } catch (error) {
      if (!new Set(["DEVICE_OFFLINE", "RELAY_DISCONNECTED", "COMMAND_TIMEOUT", "NO_PENDING_APPROVAL"]).has(error?.code)) {
        throw error;
      }
    }
  }

  async navigate(args) {
    const operation = requireSession(this, args.sessionId);
    const payload = { ...args };
    if (args.action === "open") {
      if (!args.url) throw new Error("url is required for open");
      const url = validateHttpsUrl(args.url, "url");
      if (!operation.allowedOrigins.includes(url.origin)) {
        throw Object.assign(new Error(`origin is not approved: ${url.origin}`), { code: "ORIGIN_NOT_APPROVED" });
      }
      payload.url = url.href;
    } else if (args.url) {
      throw new Error("url is only allowed with action=open");
    }
    return await this.command("page.navigate", payload);
  }

  async element(args) {
    if (args.action === "type" && args.text == null) throw new Error("text is required for type");
    if (args.action !== "type" && args.text != null) throw new Error("text is only allowed for type");
    const gestureFields = ["durationMs", "x", "y", "endX", "endY"];
    if (!["press", "drag"].includes(args.action) && gestureFields.some((field) => args[field] != null)) {
      throw new Error("gesture coordinates and duration are only allowed for press or drag");
    }
    if (args.action === "drag" && (args.endX == null || args.endY == null)) {
      throw new Error("endX and endY are required for drag");
    }
    if (args.action === "press" && (args.endX != null || args.endY != null)) {
      throw new Error("endX and endY are only allowed for drag");
    }
    return await this.command("element.action", args);
  }

  async command(command, args) {
    requireSession(this, args.sessionId);
    return await this.client.request(command, args, { timeoutMs: this.commandTimeoutMs });
  }

  async snapshot(args) {
    const result = await this.command("page.snapshot", { ...args, maxNodes: args.maxNodes ?? 200 });
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_SNAPSHOT_BYTES) {
      throw Object.assign(new Error("iPhone snapshot exceeded 32 KiB"), { code: "RESPONSE_TOO_LARGE" });
    }
    return result;
  }

  async screenshot(args) {
    const result = await this.command("page.screenshot", { ...args, maxWidth: args.maxWidth ?? 800 });
    if (result?.mimeType !== "image/jpeg" || typeof result.data !== "string") {
      throw new Error("iPhone returned an invalid screenshot");
    }
    if (result.data.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 4) {
      throw Object.assign(new Error("iPhone screenshot exceeded 1.5 MiB"), { code: "RESPONSE_TOO_LARGE" });
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(result.data)) {
      throw Object.assign(new Error("iPhone screenshot encoding is invalid"), { code: "INVALID_SCREENSHOT" });
    }
    const bytes = Buffer.from(result.data, "base64");
    if (bytes.toString("base64") !== result.data) {
      throw Object.assign(new Error("iPhone screenshot encoding is not canonical base64"), { code: "INVALID_SCREENSHOT" });
    }
    if (bytes.length > MAX_SCREENSHOT_BYTES) {
      throw Object.assign(new Error("iPhone screenshot exceeded 1.5 MiB"), { code: "RESPONSE_TOO_LARGE" });
    }
    return {
      content: [{ type: "image", data: result.data, mimeType: "image/jpeg" }],
      structuredContent: { mimeType: "image/jpeg", byteLength: bytes.length, width: result.width, height: result.height },
    };
  }

  async onReady() {
    const operation = this.operation;
    if (!operation) return;
    if (["awaiting_device", "requesting_approval"].includes(operation.state)) {
      operation.approvalPromise = null;
      await this.requestApproval(operation);
      return;
    }
    if (operation.state === "interrupted" && operation.sessionId) {
      try {
        const result = await this.client.request("session.resume", { sessionId: operation.sessionId }, { timeoutMs: this.commandTimeoutMs });
        if (result.state !== "ready") throw new Error("iPhone did not resume the session");
        if (operation.reconnectTimer) clearTimeout(operation.reconnectTimer);
        operation.reconnectTimer = null;
        operation.state = "ready";
        operation.stage = "active";
        operation.updatedAt = this.now();
      } catch (error) {
        await this.failInterrupted(operation, error);
      }
    }
  }

  onInterrupted() {
    const operation = this.operation;
    if (!operation || operation.state !== "ready") return;
    operation.state = "interrupted";
    operation.stage = "reconnecting";
    operation.updatedAt = this.now();
    operation.reconnectTimer = setTimeout(
      () => void this.failInterrupted(operation, Object.assign(new Error("cellular reconnect grace expired"), { code: "RECONNECT_TIMEOUT" })),
      this.reconnectGraceMs,
    );
    operation.reconnectTimer.unref?.();
  }

  async failInterrupted(operation, error) {
    if (this.operation !== operation || operation.state !== "interrupted") return;
    operation.state = "failed";
    operation.stage = "finished";
    operation.error = { code: error?.code ?? "SESSION_INTERRUPTED", message: error.message, retryable: true };
    operation.sessionId = null;
    operation.updatedAt = this.now();
    await this.release(operation);
  }

  async onEvent(name, data) {
    const operation = this.operation;
    if (
      name === "session.approval_pending" &&
      operation &&
      data?.operationId === operation.id &&
      operation.state === "requesting_approval"
    ) {
      operation.state = "awaiting_approval";
      operation.stage = "approval";
      operation.updatedAt = this.now();
      return;
    }
    if (!operation || data?.sessionId !== operation.sessionId) return;
    if (name === "session.closed") {
      operation.state = "closed";
      operation.stage = "finished";
      operation.sessionId = null;
      operation.updatedAt = this.now();
      await this.release(operation);
    }
  }

  async release(operation) {
    if (operation.approvalTimer) clearTimeout(operation.approvalTimer);
    if (operation.reconnectTimer) clearTimeout(operation.reconnectTimer);
    operation.approvalTimer = null;
    operation.reconnectTimer = null;
    if (operation.leaseToken) {
      await this.lease.release(operation.leaseToken);
      operation.leaseToken = null;
    }
    this.scheduleTerminalExpiry(operation);
  }

  scheduleTerminalExpiry(operation) {
    if (this.shuttingDown || !TERMINAL_STATES.has(operation.state) || this.terminalRetentionMs < 0) return;
    if (this.terminalTimer) clearTimeout(this.terminalTimer);
    this.terminalTimer = setTimeout(() => {
      if (this.operation === operation && TERMINAL_STATES.has(operation.state)) this.operation = null;
      this.terminalTimer = null;
    }, this.terminalRetentionMs);
    this.terminalTimer.unref?.();
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.terminalTimer) clearTimeout(this.terminalTimer);
    this.terminalTimer = null;
    if (this.operation && !["closed", "cancelled", "failed", "timed_out", "rejected"].includes(this.operation.state)) {
      await this.closeSession("closed").catch(() => this.release(this.operation));
    }
    await this.client.close();
  }

  async destroy() {
    await this.shutdown();
  }
}

export async function createCellularBrowserPluginFromEnvironment(options = {}) {
  const identityPath = options.identityPath ?? process.env.IPHONE_BRIDGE_CELLULAR_IDENTITY_FILE;
  const relayUrl = options.relayUrl ?? process.env.IPHONE_BRIDGE_CELLULAR_RELAY_URL;
  if (!identityPath) throw new Error("Set IPHONE_BRIDGE_CELLULAR_IDENTITY_FILE for cellular mode");
  if (!relayUrl) throw new Error("Set IPHONE_BRIDGE_CELLULAR_RELAY_URL for cellular mode");
  const identity = options.identity ?? (await loadHostIdentity(identityPath));
  const client = options.client ?? new CellularRelayClient({ identity, relayUrl });
  client.on("warning", (error) => {
    console.error(`WARN cellular relay: ${error instanceof Error ? error.message : String(error)}`);
  });
  return new CellularBrowserPlugin({ ...options, identity, client, alias: options.alias ?? process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_ALIAS });
}

export {
  COMMAND_TIMEOUT_MS,
  MAX_SCREENSHOT_BYTES,
  MAX_SNAPSHOT_BYTES,
  RECONNECT_GRACE_MS,
  SESSION_APPROVAL_TIMEOUT_MS,
};
