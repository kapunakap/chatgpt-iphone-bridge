import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { createSessionAction, deleteSessionAction } from "./appium-private.mjs";
import { DeviceLease } from "./device-lease.mjs";
import { runWorkerTool } from "./worker-tool.mjs";

const prepareSchema = z.object({
  action: z.enum(["start", "status", "cancel"]),
  udid: z.string().min(1).optional(),
  provisioningProfileUuid: z.string().min(1).optional(),
  forceRebuild: z.boolean().optional(),
  operationId: z.string().min(1).optional(),
});

const createSchema = z.object({
  action: z.enum(["start", "status", "cancel"]),
  udid: z.string().min(1).optional(),
  capabilities: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  operationId: z.string().min(1).optional(),
});

function resultText(result) {
  return result?.content?.find((item) => item.type === "text")?.text ?? "";
}

function parseJsonText(result, label) {
  const text = resultText(result);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function successContent(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorContent(error, code = "BRIDGE_OPERATION_ERROR") {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `iPhone bridge error: ${message}` }],
    structuredContent: { error: { code, message, retryable: false } },
  };
}

function canonicalHash(kind, args) {
  return createHash("sha256").update(JSON.stringify({ kind, args })).digest("hex");
}

function parseCapabilities(value) {
  let parsed = value;
  if (typeof value === "string") parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("capabilities must be a JSON object");
  }
  return { ...parsed };
}

function findCreatedSessionId(result, sessions, beforeIds) {
  const match = resultText(result).match(/session created successfully with ID:\s*([^\s]+)/i);
  if (match && sessions.some((session) => session.sessionId === match[1] && session.ownership === "owned")) {
    return match[1];
  }
  const created = sessions.filter((session) => session.ownership === "owned" && !beforeIds.has(session.sessionId));
  return created.length === 1 ? created[0].sessionId : null;
}

function validateInitialUrl(capabilities) {
  for (const key of ["appium:initialDeeplinkUrl", "appium:safariInitialUrl"]) {
    const raw = capabilities[key];
    if (raw == null || raw === "") continue;
    const url = new URL(raw);
    if (!new Set(["http:", "https:"]).has(url.protocol)) {
      throw new Error(`${key} must use http or https`);
    }
    if (url.username || url.password) throw new Error(`${key} must not contain credentials`);
  }
}

function sanitizePrepareResult(payload) {
  const copy = structuredClone(payload);
  delete copy.udid;
  for (const key of ["profiles", "recommendedProfiles"]) {
    if (Array.isArray(copy[key])) {
      copy[key] = copy[key].map(({ filePath: _filePath, ...profile }) => profile);
    }
  }
  if (copy.capabilitiesHint && typeof copy.capabilitiesHint === "object") {
    delete copy.capabilitiesHint["appium:udid"];
  }
  return copy;
}

function publicOperation(operation, now) {
  const payload = {
    operationId: operation.id,
    kind: operation.kind,
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
  return payload;
}

export class AsyncSessionPlugin {
  constructor(options = {}) {
    this.name = "openai-local-iphone-lifecycle";
    this.version = "0.2.0-beta.1";
    this.createSession = options.createSession ?? createSessionAction;
    this.deleteSession = options.deleteSession ?? deleteSessionAction;
    this.prepareDevice =
      options.prepareDevice ??
      ((args, operationOptions) =>
        runWorkerTool("appium_prepare_ios_real_device", args, {
          signal: operationOptions.signal,
          timeoutMs: operationOptions.timeoutMs,
        }));
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? randomUUID;
    this.schedule = options.schedule ?? queueMicrotask;
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? 10 * 60_000;
    this.createTimeoutMs = options.createTimeoutMs ?? 90_000;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 15_000;
    this.lease = options.lease ?? new DeviceLease();
    this.requirePreparation = options.requirePreparation ?? true;
    this.core = null;
    this.selectedUdids = new Set();
    this.preparedByUdid = new Map();
    this.operations = new Map();
    this.lastOperationId = null;
    this.shuttingDown = false;
  }

  register(registry, core) {
    this.core = core;
    registry.addTool({
      name: "appium_prepare_ios_real_device_async",
      description:
        "Prepare one selected real iPhone or iPad without blocking the MCP request. WDA signing is serialized because its cache is shared. Start, poll status, or cancel by operationId.",
      parameters: prepareSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      execute: async (rawArgs) => {
        try {
          return await this.executeTool("prepare", prepareSchema.parse(rawArgs));
        } catch (error) {
          return errorContent(error, "INVALID_ARGUMENTS");
        }
      },
    });
    registry.addTool({
      name: "appium_create_session_async",
      description:
        "Create a prepared real-iPhone or iPad Safari session without blocking the MCP request. Pass udid when more than one device is selected; sessions for different UDIDs may coexist. Poll or cancel by operationId.",
      parameters: createSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      execute: async (rawArgs) => {
        try {
          return await this.executeTool("create", createSchema.parse(rawArgs));
        } catch (error) {
          return errorContent(error, "INVALID_ARGUMENTS");
        }
      },
    });
  }

  async executeTool(kind, args) {
    if (args.action === "start") return await this.start(kind, args);
    if (args.action === "status") return this.status(args.operationId);
    return await this.cancel(args.operationId);
  }

  async start(kind, rawArgs) {
    if (this.shuttingDown) return errorContent(new Error("bridge shutdown is in progress"), "SHUTTING_DOWN");
    if (!this.core) return errorContent(new Error("lifecycle plugin is not initialized"));

    let normalized;
    try {
      normalized = kind === "prepare" ? this.validatePrepareArgs(rawArgs) : this.validateCreateArgs(rawArgs);
    } catch (error) {
      return errorContent(error, "INVALID_ARGUMENTS");
    }

    const inputHash = canonicalHash(kind, normalized);
    const deviceOperations = [...this.operations.values()].filter(
      (operation) => operation.udid === normalized.udid,
    );
    const duplicate = deviceOperations.find(
      (operation) =>
        operation.kind === kind &&
        operation.inputHash === inputHash &&
        (["starting", "cancelling"].includes(operation.state) ||
          (operation.kind === "create" && operation.state === "ready" && operation.sessionId)),
    );
    if (duplicate) return successContent(publicOperation(duplicate, this.now));

    const pending = deviceOperations.find((operation) => ["starting", "cancelling"].includes(operation.state));
    if (pending) {
      return errorContent(
        new Error(`operation ${pending.id} for this device is still ${pending.state}`),
        "OPERATION_IN_PROGRESS",
      );
    }
    const readySession = deviceOperations.find(
      (operation) => operation.state === "ready" && operation.kind === "create" && operation.sessionId,
    );
    if (readySession) {
      return errorContent(new Error("an owned Safari session is already active"), "SESSION_ACTIVE");
    }
    if (
      this.core
        .listSessions()
        .some(
          (session) =>
            session.ownership === "owned" && session.capabilities?.["appium:udid"] === normalized.udid,
        )
    ) {
      return errorContent(new Error("an owned Appium session is already active for this device"), "SESSION_ACTIVE");
    }

    const leaseTokens = [];
    try {
      leaseTokens.push(await this.lease.acquire(kind, normalized.udid));
      if (kind === "prepare") leaseTokens.push(await this.lease.acquire(kind, "shared-wda-preparation"));
    } catch (error) {
      await Promise.allSettled(leaseTokens.map((token) => this.lease.release(token)));
      return errorContent(error, "LEASE_BUSY");
    }

    const now = this.now();
    const operation = {
      id: this.makeId(),
      kind,
      udid: normalized.udid,
      inputHash,
      args: normalized,
      state: "starting",
      stage: kind === "prepare" ? "preparing_wda" : "creating_safari",
      startedAt: now,
      updatedAt: now,
      cleanupPending: false,
      cancelRequested: false,
      sessionId: null,
      result: null,
      error: null,
      controller: new AbortController(),
      leaseTokens,
      timer: null,
      promise: null,
    };
    const timeoutMs = kind === "prepare" ? this.prepareTimeoutMs : this.createTimeoutMs;
    operation.timer = setTimeout(() => this.timeout(operation, timeoutMs), timeoutMs);
    operation.timer.unref?.();
    this.operations.set(operation.id, operation);
    this.lastOperationId = operation.id;
    this.schedule(() => {
      operation.promise = this.run(operation);
      void operation.promise;
    });
    return successContent(publicOperation(operation, this.now));
  }

  validatePrepareArgs(args) {
    if (!args.udid) throw new Error("udid is required for prepare start");
    if (!this.selectedUdids.has(args.udid)) {
      throw new Error("select this real iOS device before preparation");
    }
    return {
      udid: args.udid,
      ...(args.provisioningProfileUuid ? { provisioningProfileUuid: args.provisioningProfileUuid } : {}),
      ...(args.forceRebuild === true ? { forceRebuild: true } : {}),
    };
  }

  validateCreateArgs(args) {
    if (args.capabilities == null) throw new Error("capabilities are required for create start");
    const capabilities = parseCapabilities(args.capabilities);
    if (capabilities.browserName !== "Safari") throw new Error("only browserName=Safari is allowed");
    if (capabilities["appium:app"] || capabilities["appium:bundleId"]) {
      throw new Error("native application capabilities are not allowed");
    }
    const explicitUdid = capabilities["appium:udid"];
    if (args.udid && explicitUdid && args.udid !== explicitUdid) {
      throw new Error("top-level UDID does not match the capability UDID");
    }
    const udid = args.udid ?? explicitUdid ?? (this.selectedUdids.size === 1 ? [...this.selectedUdids][0] : null);
    if (!udid) throw new Error("udid is required when more than one iOS device is selected");
    if (!this.selectedUdids.has(udid)) throw new Error("select this real iOS device before session creation");
    capabilities["appium:udid"] = udid;
    capabilities["appium:deviceName"] ||= "iOS Device";
    capabilities["appium:wdaLaunchTimeout"] ||= 30_000;
    validateInitialUrl(capabilities);

    if (this.requirePreparation) {
      const prepared = this.preparedByUdid.get(udid);
      if (!prepared) throw new Error("successfully prepare this iOS device before session creation");
      const expectedPath = prepared.capabilitiesHint?.["appium:prebuiltWDAPath"];
      if (!expectedPath || capabilities["appium:prebuiltWDAPath"] !== expectedPath) {
        throw new Error("prebuilt WDA path does not match the successful preparation result");
      }
      if (capabilities["appium:usePreinstalledWDA"] !== true) {
        throw new Error("appium:usePreinstalledWDA=true is required");
      }
    }
    return { udid, capabilities };
  }

  timeout(operation, timeoutMs) {
    if (this.operations.get(operation.id) !== operation || operation.state !== "starting") return;
    operation.state = "timed_out";
    operation.stage = "cleanup";
    operation.updatedAt = this.now();
    operation.cancelRequested = true;
    operation.cleanupPending = true;
    operation.error = {
      code: "OPERATION_TIMEOUT",
      message: `${operation.kind} exceeded ${timeoutMs} ms`,
      retryable: true,
    };
    operation.controller.abort();
  }

  async run(operation) {
    try {
      if (operation.kind === "prepare") await this.runPrepare(operation);
      else await this.runCreate(operation);
    } catch (error) {
      if (["timed_out", "cancelling", "cancelled"].includes(operation.state)) {
        operation.state = operation.state === "timed_out" ? "timed_out" : "cancelled";
      } else {
        operation.state = "failed";
        operation.error = {
          code: "OPERATION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        };
      }
      operation.stage = "finished";
      operation.updatedAt = this.now();
    } finally {
      if (operation.timer) clearTimeout(operation.timer);
      if (operation.kind === "prepare" || operation.state !== "ready") {
        await this.releaseOperationLease(operation);
      }
    }
  }

  async runPrepare(operation) {
    const result = await this.prepareDevice(operation.args, {
      signal: operation.controller.signal,
      timeoutMs: this.prepareTimeoutMs,
    });
    if (result?.isError) throw new Error(resultText(result) || "iPhone preparation failed");
    const payload = parseJsonText(result, "iPhone preparation");
    if (operation.cancelRequested) {
      operation.state = operation.state === "timed_out" ? "timed_out" : "cancelled";
      operation.cleanupPending = false;
      operation.stage = "finished";
      operation.updatedAt = this.now();
      return;
    }
    if (payload.mode === "build") {
      if (payload.ready !== true) {
        const failedStage = Object.entries(payload).find(([, value]) => value?.status === "failed");
        throw new Error(failedStage?.[1]?.detail || "WDA preparation did not become ready");
      }
      if (payload.udid !== operation.args.udid || !payload.capabilitiesHint?.["appium:prebuiltWDAPath"]) {
        throw new Error("preparation returned inconsistent device or WDA capabilities");
      }
      this.preparedByUdid.set(payload.udid, {
        udid: payload.udid,
        capabilitiesHint: { ...payload.capabilitiesHint },
      });
    }
    operation.result = sanitizePrepareResult(payload);
    operation.state = "ready";
    operation.stage = "finished";
    operation.cleanupPending = false;
    operation.updatedAt = this.now();
  }

  async runCreate(operation) {
    const beforeIds = new Set(this.core.listSessions().map((session) => session.sessionId));
    const result = await this.createSession({ platform: "ios", capabilities: operation.args.capabilities });
    const sessionId = findCreatedSessionId(result, this.core.listSessions(), beforeIds);

    if (operation.cancelRequested || operation.state === "timed_out") {
      if (sessionId) await this.cleanupSession(operation, sessionId);
      operation.state = operation.state === "timed_out" ? "timed_out" : "cancelled";
      operation.stage = "finished";
      operation.updatedAt = this.now();
      operation.cleanupPending = false;
      return;
    }
    if (result?.isError) throw new Error(resultText(result) || "Safari session creation failed");
    if (!sessionId) throw new Error("session creation completed without exactly one new owned session");

    operation.sessionId = sessionId;
    operation.result = { sessionId };
    operation.state = "ready";
    operation.stage = "finished";
    operation.cleanupPending = false;
    operation.updatedAt = this.now();
  }

  status(operationId) {
    const operation = this.getOperation(operationId);
    if (operation instanceof Error) return errorContent(operation, "UNKNOWN_OPERATION");
    return successContent(publicOperation(operation, this.now));
  }

  async cancel(operationId) {
    const operation = this.getOperation(operationId);
    if (operation instanceof Error) return errorContent(operation, "UNKNOWN_OPERATION");
    if (
      ["cancelled", "failed", "timed_out", "closed", "cleanup_failed"].includes(operation.state) ||
      (operation.kind === "prepare" && operation.state === "ready")
    ) {
      return successContent(publicOperation(operation, this.now));
    }
    operation.cancelRequested = true;
    operation.controller.abort();
    if (operation.timer) clearTimeout(operation.timer);
    operation.state = "cancelling";
    operation.stage = "cleanup";
    operation.cleanupPending = true;
    operation.updatedAt = this.now();

    if (operation.sessionId) {
      operation.promise = this.finishReadyCancellation(operation);
      void operation.promise;
    }
    return successContent(publicOperation(operation, this.now));
  }

  async finishReadyCancellation(operation) {
    try {
      await this.cleanupSession(operation, operation.sessionId);
      operation.sessionId = null;
      operation.state = "cancelled";
      operation.cleanupPending = false;
      operation.stage = "finished";
      operation.updatedAt = this.now();
      await this.releaseOperationLease(operation);
    } catch (error) {
      operation.state = "cleanup_failed";
      operation.error = {
        code: "CLEANUP_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
      operation.updatedAt = this.now();
    }
  }

  async cleanupSession(operation, sessionId) {
    const result = await this.deleteSession(sessionId);
    if (result?.isError) throw new Error(resultText(result) || "session cleanup failed");
    if (this.core.listSessions().some((session) => session.sessionId === sessionId)) {
      throw new Error("session cleanup returned but the session is still tracked");
    }
    operation.cleanupPending = false;
  }

  getOperation(operationId) {
    if (operationId) return this.operations.get(operationId) ?? new Error(`unknown operationId: ${operationId}`);
    if (this.operations.size === 0) return new Error("no lifecycle operation exists");
    if (this.operations.size === 1) return this.operations.values().next().value;
    const current = [...this.operations.values()].filter(
      (operation) =>
        ["starting", "cancelling"].includes(operation.state) ||
        (operation.kind === "create" && operation.state === "ready" && operation.sessionId),
    );
    if (current.length === 1) return current[0];
    if (current.length === 0 && this.lastOperationId) return this.operations.get(this.lastOperationId);
    return new Error("operationId is required when multiple lifecycle operations are active");
  }

  async releaseOperationLease(operation) {
    if (!operation.leaseTokens?.length) return;
    const tokens = operation.leaseTokens;
    const results = await Promise.allSettled(tokens.map((token) => this.lease.release(token)));
    operation.leaseTokens = tokens.filter((_token, index) => results[index].status === "rejected");
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
  }

  async afterCall(ctx, result) {
    if (ctx.toolName === "select_device") {
      if (result.isError || ctx.args.platform !== "ios" || ctx.args.iosDeviceType !== "real") return;
      try {
        const selected = parseJsonText(result, "device selection");
        const udid = selected?.capabilities?.["appium:udid"];
        if (typeof udid === "string" && udid) this.selectedUdids.add(udid);
      } catch {}
      return;
    }

    if (ctx.toolName === "appium_session_management" && ctx.args.action === "delete") {
      const liveSessionIds = new Set(this.core.listSessions().map((session) => session.sessionId));
      for (const operation of this.operations.values()) {
        if (operation.state !== "ready" || !operation.sessionId || liveSessionIds.has(operation.sessionId)) continue;
        operation.sessionId = null;
        operation.state = "closed";
        operation.stage = "finished";
        operation.updatedAt = this.now();
        await this.releaseOperationLease(operation);
      }
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    const results = await Promise.allSettled(
      [...this.operations.values()].map((operation) => this.shutdownOperation(operation)),
    );
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length > 0) throw new AggregateError(errors, "one or more device operations failed to shut down");
  }

  async shutdownOperation(operation) {
    operation.cancelRequested = true;
    operation.controller.abort();
    if (operation.timer) clearTimeout(operation.timer);

    if (operation.sessionId) {
      try {
        await this.cleanupSession(operation, operation.sessionId);
        operation.sessionId = null;
      } catch (error) {
        operation.state = "cleanup_failed";
        operation.error = {
          code: "CLEANUP_FAILED",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        };
      }
    } else if (operation.promise) {
      await Promise.race([
        operation.promise.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, this.cleanupTimeoutMs).unref()),
      ]);
    }

    if (!operation.sessionId || !this.core.listSessions().some((session) => session.sessionId === operation.sessionId)) {
      await this.releaseOperationLease(operation);
    }
  }

  async destroy() {
    await this.shutdown();
  }
}
