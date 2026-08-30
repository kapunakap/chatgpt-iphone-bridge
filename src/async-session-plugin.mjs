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
    this.selectedUdid = null;
    this.prepared = null;
    this.operation = null;
    this.shuttingDown = false;
  }

  register(registry, core) {
    this.core = core;
    registry.addTool({
      name: "appium_prepare_ios_real_device_async",
      description:
        "Prepare a selected real iPhone without blocking the MCP request. Start, poll status, or cancel the operation.",
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
        "Create a prepared real-iPhone Safari session without blocking the MCP request. Start, poll status, or cancel the operation.",
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
    if (this.operation && ["starting", "cancelling"].includes(this.operation.state)) {
      if (this.operation.kind === kind && this.operation.inputHash === inputHash) {
        return successContent(publicOperation(this.operation, this.now));
      }
      return errorContent(
        new Error(`operation ${this.operation.id} is still ${this.operation.state}`),
        "OPERATION_IN_PROGRESS",
      );
    }
    if (this.operation?.state === "ready" && this.operation.kind === "create" && this.operation.sessionId) {
      if (this.operation.inputHash === inputHash) return successContent(publicOperation(this.operation, this.now));
      return errorContent(new Error("an owned Safari session is already active"), "SESSION_ACTIVE");
    }
    if (this.core.listSessions().some((session) => session.ownership === "owned")) {
      return errorContent(new Error("an owned Appium session is already active"), "SESSION_ACTIVE");
    }

    let leaseToken;
    try {
      leaseToken = await this.lease.acquire(kind);
    } catch (error) {
      return errorContent(error, "LEASE_BUSY");
    }

    const now = this.now();
    const operation = {
      id: this.makeId(),
      kind,
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
      leaseToken,
      timer: null,
      promise: null,
    };
    const timeoutMs = kind === "prepare" ? this.prepareTimeoutMs : this.createTimeoutMs;
    operation.timer = setTimeout(() => this.timeout(operation, timeoutMs), timeoutMs);
    operation.timer.unref?.();
    this.operation = operation;
    this.schedule(() => {
      operation.promise = this.run(operation);
      void operation.promise;
    });
    return successContent(publicOperation(operation, this.now));
  }

  validatePrepareArgs(args) {
    if (!args.udid) throw new Error("udid is required for prepare start");
    if (!this.selectedUdid) throw new Error("select a real iPhone before preparation");
    if (args.udid !== this.selectedUdid) throw new Error("prepare UDID does not match the selected iPhone");
    return {
      udid: args.udid,
      ...(args.provisioningProfileUuid ? { provisioningProfileUuid: args.provisioningProfileUuid } : {}),
      ...(args.forceRebuild === true ? { forceRebuild: true } : {}),
    };
  }

  validateCreateArgs(args) {
    if (args.capabilities == null) throw new Error("capabilities are required for create start");
    if (!this.selectedUdid) throw new Error("select a real iPhone before session creation");
    const capabilities = parseCapabilities(args.capabilities);
    if (capabilities.browserName !== "Safari") throw new Error("only browserName=Safari is allowed");
    if (capabilities["appium:app"] || capabilities["appium:bundleId"]) {
      throw new Error("native application capabilities are not allowed");
    }
    const explicitUdid = capabilities["appium:udid"];
    if (explicitUdid && explicitUdid !== this.selectedUdid) {
      throw new Error("capability UDID does not match the selected iPhone");
    }
    capabilities["appium:udid"] = this.selectedUdid;
    capabilities["appium:deviceName"] ||= "iPhone";
    capabilities["appium:wdaLaunchTimeout"] ||= 30_000;
    validateInitialUrl(capabilities);

    if (this.requirePreparation) {
      if (!this.prepared || this.prepared.udid !== this.selectedUdid) {
        throw new Error("successfully prepare the selected iPhone before session creation");
      }
      const expectedPath = this.prepared.capabilitiesHint?.["appium:prebuiltWDAPath"];
      if (!expectedPath || capabilities["appium:prebuiltWDAPath"] !== expectedPath) {
        throw new Error("prebuilt WDA path does not match the successful preparation result");
      }
      if (capabilities["appium:usePreinstalledWDA"] !== true) {
        throw new Error("appium:usePreinstalledWDA=true is required");
      }
    }
    return { capabilities };
  }

  timeout(operation, timeoutMs) {
    if (this.operation !== operation || operation.state !== "starting") return;
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
      this.prepared = {
        udid: payload.udid,
        capabilitiesHint: { ...payload.capabilitiesHint },
      };
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
    const newOwned = this.core
      .listSessions()
      .filter((session) => session.ownership === "owned" && !beforeIds.has(session.sessionId));
    const sessionId = newOwned.length === 1 ? newOwned[0].sessionId : null;

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
    if (["cancelled", "failed", "timed_out", "closed", "cleanup_failed"].includes(operation.state)) {
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
    if (!this.operation) return new Error("no lifecycle operation exists");
    if (operationId && this.operation.id !== operationId) return new Error(`unknown operationId: ${operationId}`);
    return this.operation;
  }

  async releaseOperationLease(operation) {
    if (!operation.leaseToken) return;
    await this.lease.release(operation.leaseToken);
    operation.leaseToken = null;
  }

  async afterCall(ctx, result) {
    if (ctx.toolName === "select_device") {
      this.selectedUdid = null;
      this.prepared = null;
      if (result.isError || ctx.args.platform !== "ios" || ctx.args.iosDeviceType !== "real") return;
      try {
        const selected = parseJsonText(result, "device selection");
        const udid = selected?.capabilities?.["appium:udid"];
        if (typeof udid === "string" && udid) this.selectedUdid = udid;
      } catch {
        this.selectedUdid = null;
      }
      return;
    }

    if (ctx.toolName === "appium_session_management" && ctx.args.action === "delete") {
      if (this.operation?.state === "ready" && !this.core.listSessions().some((session) => session.ownership === "owned")) {
        this.operation.sessionId = null;
        this.operation.state = "closed";
        this.operation.stage = "finished";
        this.operation.updatedAt = this.now();
        await this.releaseOperationLease(this.operation);
      }
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    const operation = this.operation;
    if (!operation) return;
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

    if (!this.core.listSessions().some((session) => session.ownership === "owned")) {
      await this.releaseOperationLease(operation);
    }
  }

  async destroy() {
    await this.shutdown();
  }
}
