import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { createSessionAction, deleteSessionAction } from "./appium-private.mjs";
import { DeviceLease } from "./device-lease.mjs";
import { assertRealIphoneUnlocked } from "./ios-device-state.mjs";
import { SessionQueueStore } from "./session-queue-store.mjs";
import { runWorkerTool } from "./worker-tool.mjs";

const QUEUE_STATE_VERSION = 1;
const CREATE_TERMINAL_STATES = new Set([
  "cancelled",
  "closed",
  "expired",
  "failed",
  "interrupted",
  "timed_out",
]);
const CREATE_PERSISTED_STATES = [
  "queued",
  "starting",
  "ready",
  "cancelling",
  "closed",
  "expired",
  "failed",
  "timed_out",
  "cleanup_failed",
  "interrupted",
  "cancelled",
];

const WDA_LAUNCH_FAILURE = /Unable to launch WebDriverAgent|Failed to start the preinstalled WebDriverAgent|Connection was refused to port/i;

function classifyCreateFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.code === "DEVICE_LOCKED" || error?.code === "DEVICE_STATE_UNAVAILABLE") {
    return { code: error.code, message, retryable: error.retryable !== false };
  }
  if (WDA_LAUNCH_FAILURE.test(message)) return { code: "WDA_LAUNCH_FAILED", message, retryable: true };
  return { code: "OPERATION_FAILED", message, retryable: true };
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const error = new Error("operation was cancelled");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

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
  clientRequestId: z.string().min(1).max(200).optional(),
  operationId: z.string().min(1).optional(),
});

const persistedOperationSchema = z.object({
  id: z.string().min(1),
  clientRequestId: z.string().min(1),
  inputHash: z.string().min(1),
  state: z.enum(CREATE_PERSISTED_STATES),
  stage: z.string().min(1),
  enqueuedAt: z.number().finite(),
  startedAt: z.number().finite().nullable(),
  updatedAt: z.number().finite(),
  lastHeartbeatAt: z.number().finite(),
  cleanupPending: z.boolean(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
  args: z
    .object({
      capabilities: z.record(z.string(), z.unknown()),
    })
    .nullable(),
});

const persistedQueueSchema = z.object({
  version: z.literal(QUEUE_STATE_VERSION),
  savedAt: z.number().finite(),
  queue: z.array(z.string().min(1)),
  operations: z.array(persistedOperationSchema),
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

function errorContent(error, code = "BRIDGE_OPERATION_ERROR", retryable = false) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `iPhone bridge error: ${message}` }],
    structuredContent: { error: { code, message, retryable } },
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

function basePublicOperation(operation, now) {
  const startedAt = operation.startedAt ?? operation.enqueuedAt;
  const payload = {
    operationId: operation.id,
    kind: operation.kind,
    state: operation.state,
    stage: operation.stage,
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: new Date(operation.updatedAt).toISOString(),
    elapsedMs: Math.max(0, now() - startedAt),
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
    this.version = "0.2.0-beta.3";
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
    this.checkDeviceReady = options.checkDeviceReady ?? assertRealIphoneUnlocked;
    this.retryDelay = options.retryDelay ?? abortableDelay;
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? 10 * 60_000;
    this.createTimeoutMs = options.createTimeoutMs ?? 150_000;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 15_000;
    this.wdaRetryDelayMs = options.wdaRetryDelayMs ?? 3_000;
    this.queueHeartbeatMs = options.queueHeartbeatMs ?? 10 * 60_000;
    this.queuePollAfterMs = options.queuePollAfterMs ?? 30_000;
    this.queueRetryMs = options.queueRetryMs ?? 2_000;
    this.maxQueueSize = options.maxQueueSize ?? 20;
    this.terminalRetentionMs = options.terminalRetentionMs ?? 24 * 60 * 60_000;
    this.maxTerminalOperations = options.maxTerminalOperations ?? 100;
    this.sweepIntervalMs = options.sweepIntervalMs ?? Math.min(30_000, Math.max(1_000, this.queueHeartbeatMs / 2));
    this.lease = options.lease ?? new DeviceLease();
    this.queueStore = options.queueStore ?? new SessionQueueStore();
    this.requirePreparation = options.requirePreparation ?? true;
    this.core = null;
    this.selectedUdid = null;
    this.prepared = null;
    this.prepareOperation = null;
    this.operations = new Map();
    this.clientRequests = new Map();
    this.queue = [];
    this.activeOperation = null;
    this.initialized = false;
    this.initializationPromise = null;
    this.stateTail = Promise.resolve();
    this.schedulerRunning = false;
    this.retryTimer = null;
    this.sweepTimer = null;
    this.persistenceError = null;
    this.shuttingDown = false;
  }

  register(registry, core) {
    this.core = core;
    registry.addTool({
      name: "appium_prepare_ios_real_device_async",
      description:
        "Prepare the shared selected real iPhone without blocking the MCP request. Start, poll status, or cancel the operation.",
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
        "Request a private FIFO waiting-room spot for a prepared real-iPhone Safari session. Start with a unique clientRequestId, then poll or cancel with the returned operationId.",
      parameters: createSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      execute: async (rawArgs) => {
        try {
          return await this.executeTool("create", createSchema.parse(rawArgs));
        } catch (error) {
          return errorContent(error, "INVALID_ARGUMENTS");
        }
      },
    });
  }

  async initialize(ctx) {
    this.core ??= ctx.core;
    await this.ensureInitialized();
    this.startSweeper();
    this.kickScheduler();
  }

  async ensureInitialized() {
    if (this.initialized) return;
    this.initializationPromise ??= this.restoreQueue();
    await this.initializationPromise;
    this.initialized = true;
  }

  async restoreQueue() {
    const raw = await this.queueStore.load();
    if (raw == null) return;
    let persisted;
    try {
      persisted = persistedQueueSchema.parse(raw);
    } catch (error) {
      throw new Error(`Persisted iPhone queue is invalid or unsupported: ${error instanceof Error ? error.message : String(error)}`);
    }

    const ids = new Set();
    for (const saved of persisted.operations) {
      if (ids.has(saved.id)) throw new Error(`Persisted iPhone queue contains duplicate operation ${saved.id}`);
      ids.add(saved.id);
      if (this.clientRequests.has(saved.clientRequestId)) {
        throw new Error(`Persisted iPhone queue contains duplicate clientRequestId ${saved.clientRequestId}`);
      }
      const now = this.now();
      const interrupted = ["starting", "ready", "cancelling", "cleanup_failed"].includes(saved.state);
      const operation = {
        ...saved,
        kind: "create",
        state: interrupted ? "interrupted" : saved.state,
        stage: interrupted ? "finished" : saved.stage,
        updatedAt: interrupted ? now : saved.updatedAt,
        lastHeartbeatAt: saved.state === "queued" ? now : saved.lastHeartbeatAt,
        needsHeartbeat: saved.state === "queued",
        waitingReason: saved.state === "queued" ? "restart_confirmation" : null,
        cleanupPending: false,
        error: interrupted
          ? { code: "BRIDGE_RESTARTED", message: "the bridge restarted before the session finished", retryable: true }
          : saved.error,
        args: saved.args,
        result: null,
        sessionId: null,
        cancelRequested: false,
        controller: null,
        leaseToken: null,
        timer: null,
        promise: null,
      };
      this.operations.set(operation.id, operation);
      this.clientRequests.set(operation.clientRequestId, operation.id);
    }

    const queuedIds = new Set(persisted.queue);
    if (queuedIds.size !== persisted.queue.length) throw new Error("Persisted iPhone queue contains duplicate queue entries");
    for (const operationId of persisted.queue) {
      const operation = this.operations.get(operationId);
      if (!operation || operation.state !== "queued" || !operation.args) {
        throw new Error(`Persisted iPhone queue contains invalid waiting operation ${operationId}`);
      }
      this.queue.push(operationId);
    }
    for (const operation of this.operations.values()) {
      if (operation.state === "queued" && !queuedIds.has(operation.id)) {
        throw new Error(`Persisted waiting operation ${operation.id} is missing from FIFO order`);
      }
    }
    this.pruneTerminalsLocked();
    await this.persistLocked();
  }

  startSweeper() {
    if (this.sweepTimer || this.sweepIntervalMs <= 0) return;
    this.sweepTimer = setInterval(() => {
      this.trackBackground(
        this.withStateLock(async () => {
          if (this.sweepExpiredLocked()) await this.persistLocked();
        }).then(() => this.kickScheduler()),
      );
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  async executeTool(kind, args) {
    await this.ensureInitialized();
    if (kind === "prepare") {
      if (args.action === "start") return await this.startPrepare(args);
      if (!args.operationId) return errorContent(new Error("operationId is required"), "INVALID_ARGUMENTS");
      if (args.action === "status") return this.statusPrepare(args.operationId);
      return await this.cancelPrepare(args.operationId);
    }
    if (args.action === "start") return await this.startCreate(args);
    if (!args.operationId) return errorContent(new Error("operationId is required"), "INVALID_ARGUMENTS");
    if (args.action === "status") return await this.statusCreate(args.operationId);
    return await this.cancelCreate(args.operationId);
  }

  async startPrepare(rawArgs) {
    if (this.shuttingDown) return errorContent(new Error("bridge shutdown is in progress"), "SHUTTING_DOWN");
    if (!this.core) return errorContent(new Error("lifecycle plugin is not initialized"));
    let normalized;
    try {
      normalized = this.validatePrepareArgs(rawArgs);
    } catch (error) {
      return errorContent(error, "INVALID_ARGUMENTS");
    }

    if (this.prepared?.udid === normalized.udid && normalized.forceRebuild !== true) {
      if (this.prepareOperation?.state !== "ready") {
        const now = this.now();
        const capabilitiesHint = { ...this.prepared.capabilitiesHint };
        delete capabilitiesHint["appium:udid"];
        this.prepareOperation = {
          id: this.makeId(),
          kind: "prepare",
          inputHash: canonicalHash("prepare", normalized),
          args: normalized,
          state: "ready",
          stage: "finished",
          enqueuedAt: now,
          startedAt: now,
          updatedAt: now,
          cleanupPending: false,
          cancelRequested: false,
          sessionId: null,
          result: this.prepared.publicResult ?? { mode: "build", ready: true, capabilitiesHint },
          error: null,
          controller: null,
          leaseToken: null,
          timer: null,
          promise: null,
        };
      }
      return successContent(basePublicOperation(this.prepareOperation, this.now));
    }
    if (this.activeOperation || this.queue.length > 0 || this.core.listSessions().some((session) => session.ownership === "owned")) {
      return errorContent(new Error("Safari session work is active or waiting; preparation cannot jump the queue"), "SESSION_ACTIVE", true);
    }

    const inputHash = canonicalHash("prepare", normalized);
    if (this.prepareOperation && ["starting", "cancelling"].includes(this.prepareOperation.state)) {
      if (this.prepareOperation.inputHash === inputHash) {
        return successContent(basePublicOperation(this.prepareOperation, this.now));
      }
      return errorContent(
        new Error(`operation ${this.prepareOperation.id} is still ${this.prepareOperation.state}`),
        "OPERATION_IN_PROGRESS",
        true,
      );
    }

    let leaseToken;
    try {
      leaseToken = await this.lease.acquire("prepare");
    } catch (error) {
      return errorContent(error, "LEASE_BUSY", true);
    }
    const now = this.now();
    const operation = {
      id: this.makeId(), kind: "prepare", inputHash, args: normalized,
      state: "starting", stage: "preparing_wda", enqueuedAt: now, startedAt: now, updatedAt: now,
      cleanupPending: false, cancelRequested: false, sessionId: null, result: null, error: null,
      controller: new AbortController(), leaseToken, timer: null, promise: null,
    };
    operation.timer = setTimeout(() => this.timeoutPrepare(operation), this.prepareTimeoutMs);
    operation.timer.unref?.();
    this.prepareOperation = operation;
    this.schedule(() => {
      operation.promise = this.runPrepareOperation(operation);
      this.trackBackground(operation.promise);
    });
    return successContent(basePublicOperation(operation, this.now));
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
    if (!args.clientRequestId) throw new Error("clientRequestId is required for create start");
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
    const requestedWdaLaunchTimeout = Number(capabilities["appium:wdaLaunchTimeout"] ?? 0);
    capabilities["appium:wdaLaunchTimeout"] =
      Number.isFinite(requestedWdaLaunchTimeout) && requestedWdaLaunchTimeout >= 60_000
        ? requestedWdaLaunchTimeout
        : 60_000;
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
    return { clientRequestId: args.clientRequestId, capabilities };
  }

  async startCreate(rawArgs) {
    if (this.shuttingDown) return errorContent(new Error("bridge shutdown is in progress"), "SHUTTING_DOWN");
    if (!this.core) return errorContent(new Error("lifecycle plugin is not initialized"));
    if (this.persistenceError) return errorContent(this.persistenceError, "QUEUE_STATE_ERROR");
    let normalized;
    try {
      normalized = this.validateCreateArgs(rawArgs);
    } catch (error) {
      return errorContent(error, "INVALID_ARGUMENTS");
    }
    const args = { capabilities: normalized.capabilities };
    const inputHash = canonicalHash("create", args);

    const result = await this.withStateLock(async () => {
      if (this.sweepExpiredLocked()) await this.persistLocked();
      const existingId = this.clientRequests.get(normalized.clientRequestId);
      if (existingId) {
        const existing = this.operations.get(existingId);
        if (!existing) throw new Error("queue request index is inconsistent");
        if (existing.inputHash !== inputHash) {
          return errorContent(new Error("clientRequestId was already used with different capabilities"), "IDEMPOTENCY_CONFLICT");
        }
        return successContent(this.publicCreateOperation(existing));
      }
      if (this.queue.length >= this.maxQueueSize) {
        return errorContent(new Error(`the iPhone waiting room is full (${this.maxQueueSize})`), "QUEUE_FULL", true);
      }

      const now = this.now();
      const operation = {
        id: this.makeId(), kind: "create", clientRequestId: normalized.clientRequestId, inputHash, args,
        state: "queued", stage: "waiting_for_iphone", enqueuedAt: now, startedAt: null, updatedAt: now,
        lastHeartbeatAt: now, needsHeartbeat: false,
        waitingReason: this.currentWaitingReason("waiting_for_iphone"),
        cleanupPending: false, cancelRequested: false, sessionId: null, result: null, error: null,
        controller: null, leaseToken: null, timer: null, promise: null,
      };
      this.operations.set(operation.id, operation);
      this.clientRequests.set(operation.clientRequestId, operation.id);
      this.queue.push(operation.id);
      try {
        await this.persistLocked();
      } catch (error) {
        this.queue.pop();
        this.operations.delete(operation.id);
        this.clientRequests.delete(operation.clientRequestId);
        throw error;
      }
      return successContent(this.publicCreateOperation(operation));
    });
    this.kickScheduler();
    return result;
  }

  publicCreateOperation(operation) {
    const payload = basePublicOperation(operation, this.now);
    if (operation.state === "queued") {
      const index = this.queue.indexOf(operation.id);
      payload.queuePosition = index >= 0 ? index + 1 : null;
      payload.queueDepth = this.queue.length;
      payload.waitingReason = operation.waitingReason ?? "waiting_for_iphone";
      payload.heartbeatExpiresAt = new Date(operation.lastHeartbeatAt + this.queueHeartbeatMs).toISOString();
      payload.pollAfterMs = this.queuePollAfterMs;
    }
    return payload;
  }

  currentWaitingReason(fallback) {
    if (this.activeOperation?.state === "cleanup_failed") return "cleanup_failed";
    if (this.activeOperation) return "active_session";
    return fallback;
  }

  async statusCreate(operationId) {
    const result = await this.withStateLock(async () => {
      const expired = this.sweepExpiredLocked();
      const operation = this.operations.get(operationId);
      if (!operation) return errorContent(new Error(`unknown operationId: ${operationId}`), "UNKNOWN_OPERATION");
      if (operation.state === "queued") {
        operation.lastHeartbeatAt = this.now();
        operation.needsHeartbeat = false;
        const fallback = ["external_lease", "queue_state_error"].includes(operation.waitingReason)
          ? operation.waitingReason
          : "waiting_for_iphone";
        operation.waitingReason = this.currentWaitingReason(fallback);
        operation.updatedAt = this.now();
        await this.persistLocked();
      } else if (expired) {
        await this.persistLocked();
      }
      return successContent(this.publicCreateOperation(operation));
    });
    this.kickScheduler();
    return result;
  }

  async cancelCreate(operationId) {
    let startReadyCleanup = null;
    const result = await this.withStateLock(async () => {
      if (this.sweepExpiredLocked()) await this.persistLocked();
      const operation = this.operations.get(operationId);
      if (!operation) return errorContent(new Error(`unknown operationId: ${operationId}`), "UNKNOWN_OPERATION");
      if (CREATE_TERMINAL_STATES.has(operation.state) || operation.state === "cleanup_failed") {
        return successContent(this.publicCreateOperation(operation));
      }
      if (operation.state === "queued") {
        this.queue = this.queue.filter((id) => id !== operation.id);
        operation.state = "cancelled";
        operation.stage = "finished";
        operation.updatedAt = this.now();
        operation.args = null;
        await this.persistLocked();
        return successContent(this.publicCreateOperation(operation));
      }

      operation.cancelRequested = true;
      operation.controller?.abort();
      if (operation.timer) clearTimeout(operation.timer);
      operation.state = "cancelling";
      operation.stage = "cleanup";
      operation.cleanupPending = true;
      operation.updatedAt = this.now();
      if (operation.sessionId) startReadyCleanup = operation;
      await this.persistLocked();
      return successContent(this.publicCreateOperation(operation));
    });
    if (startReadyCleanup) {
      startReadyCleanup.promise = this.finishReadyCancellation(startReadyCleanup);
      this.trackBackground(startReadyCleanup.promise);
    } else {
      this.kickScheduler();
    }
    return result;
  }

  kickScheduler() {
    if (!this.initialized || this.shuttingDown || this.schedulerRunning || this.persistenceError) return;
    this.schedulerRunning = true;
    this.schedule(() => {
      void this.drainQueue()
        .catch((error) => {
          this.persistenceError = error instanceof Error ? error : new Error(String(error));
        })
        .finally(() => {
          this.schedulerRunning = false;
        });
    });
  }

  async drainQueue() {
    while (!this.shuttingDown) {
      const operation = await this.withStateLock(async () => {
        if (this.sweepExpiredLocked()) await this.persistLocked();
        if (this.activeOperation || this.queue.length === 0) return null;
        const next = this.operations.get(this.queue[0]);
        if (!next || next.state !== "queued") throw new Error("iPhone queue order is inconsistent");
        if (next.needsHeartbeat) return null;
        if (this.core.listSessions().some((session) => session.ownership === "owned")) {
          next.waitingReason = "active_session";
          next.updatedAt = this.now();
          await this.persistLocked();
          this.scheduleQueueRetry();
          return null;
        }

        let leaseToken;
        try {
          leaseToken = await this.lease.acquire("create");
        } catch {
          next.waitingReason = "external_lease";
          next.updatedAt = this.now();
          await this.persistLocked();
          this.scheduleQueueRetry();
          return null;
        }

        const now = this.now();
        this.queue.shift();
        next.state = "starting";
        next.stage = "creating_safari";
        next.startedAt = now;
        next.updatedAt = now;
        next.waitingReason = null;
        next.controller = new AbortController();
        next.leaseToken = leaseToken;
        next.timer = setTimeout(() => this.trackBackground(this.timeoutCreate(next)), this.createTimeoutMs);
        next.timer.unref?.();
        this.activeOperation = next;
        try {
          await this.persistLocked();
        } catch (error) {
          this.activeOperation = null;
          next.state = "queued";
          next.stage = "waiting_for_iphone";
          next.startedAt = null;
          next.waitingReason = "queue_state_error";
          this.queue.unshift(next.id);
          await this.lease.release(leaseToken);
          next.leaseToken = null;
          throw error;
        }
        return next;
      });

      if (!operation) return;
      operation.promise = this.runCreateOperation(operation);
      await operation.promise;
      if (["ready", "cleanup_failed"].includes(operation.state)) return;
    }
  }

  scheduleQueueRetry() {
    if (this.retryTimer || this.shuttingDown) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kickScheduler();
    }, this.queueRetryMs);
    this.retryTimer.unref?.();
  }

  async timeoutCreate(operation) {
    await this.withStateLock(async () => {
      if (this.activeOperation !== operation || operation.state !== "starting") return;
      operation.state = "timed_out";
      operation.stage = "cleanup";
      operation.updatedAt = this.now();
      operation.cancelRequested = true;
      operation.cleanupPending = true;
      operation.error = {
        code: "LIFECYCLE_TIMEOUT",
        message: `create exceeded ${this.createTimeoutMs} ms`,
        retryable: true,
      };
      operation.controller?.abort();
      await this.persistLocked();
    });
  }

  async runCreateOperation(operation) {
    const beforeIds = new Set(this.core.listSessions().map((session) => session.sessionId));
    let result = null;
    let failure = null;
    let sessionId = null;

    try {
      await this.checkDeviceReady(operation.args.capabilities["appium:udid"], {
        signal: operation.controller?.signal,
        timeoutMs: 15_000,
      });
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let createError = null;
        result = null;
        try {
          result = await this.createSession({ platform: "ios", capabilities: operation.args.capabilities });
        } catch (error) {
          createError = error;
        }
        const newOwned = this.core.listSessions()
          .filter((session) => session.ownership === "owned" && !beforeIds.has(session.sessionId));
        sessionId = newOwned.length === 1 ? newOwned[0].sessionId : null;
        failure = createError
          ?? (result?.isError ? new Error(resultText(result) || "Safari session creation failed") : null)
          ?? (!sessionId ? new Error("session creation completed without exactly one new owned session") : null);
        if (!failure) break;

        const classified = classifyCreateFailure(failure);
        const shouldRetry =
          attempt === 1 &&
          classified.code === "WDA_LAUNCH_FAILED" &&
          !sessionId &&
          !operation.cancelRequested &&
          operation.state === "starting";
        if (!shouldRetry) break;
        await this.checkDeviceReady(operation.args.capabilities["appium:udid"], {
          signal: operation.controller?.signal,
          timeoutMs: 15_000,
        });
        await this.retryDelay(this.wdaRetryDelayMs, operation.controller?.signal);
      }
    } catch (error) {
      failure = error;
    }

    try {
      if (operation.cancelRequested || ["timed_out", "cancelling"].includes(operation.state)) {
        if (sessionId) {
          try {
            await this.cleanupSession(operation, sessionId);
          } catch (error) {
            await this.markCleanupFailed(operation, error);
            return;
          }
        }
        await this.withStateLock(async () => {
          operation.state = operation.state === "timed_out" ? "timed_out" : "cancelled";
          operation.stage = "finished";
          operation.updatedAt = this.now();
          operation.cleanupPending = false;
          operation.args = null;
          await this.persistLocked();
        });
      } else {
        if (failure) {
          if (sessionId) {
            try {
              await this.cleanupSession(operation, sessionId);
            } catch (error) {
              await this.markCleanupFailed(operation, error);
              return;
            }
          }
          await this.withStateLock(async () => {
            const classified = classifyCreateFailure(failure);
            operation.state = "failed";
            operation.stage = "finished";
            operation.updatedAt = this.now();
            operation.cleanupPending = false;
            operation.args = null;
            operation.error = classified;
            await this.persistLocked();
          });
        } else {
          await this.withStateLock(async () => {
            operation.sessionId = sessionId;
            operation.result = { sessionId };
            operation.state = "ready";
            operation.stage = "finished";
            operation.cleanupPending = false;
            operation.updatedAt = this.now();
            await this.persistLocked();
          });
        }
      }
    } finally {
      if (operation.timer) clearTimeout(operation.timer);
    }

    if (operation.state !== "ready") await this.finishInactiveOperation(operation);
  }

  async finishInactiveOperation(operation) {
    try {
      await this.releaseOperationLease(operation);
      await this.withStateLock(async () => {
        if (this.activeOperation === operation) this.activeOperation = null;
        await this.persistLocked();
      });
    } catch (error) {
      await this.markCleanupFailed(operation, error);
    }
  }

  async finishReadyCancellation(operation) {
    try {
      await this.cleanupSession(operation, operation.sessionId);
      await this.releaseOperationLease(operation);
      await this.withStateLock(async () => {
        operation.sessionId = null;
        operation.result = null;
        operation.args = null;
        operation.state = "cancelled";
        operation.cleanupPending = false;
        operation.stage = "finished";
        operation.updatedAt = this.now();
        if (this.activeOperation === operation) this.activeOperation = null;
        await this.persistLocked();
      });
      this.kickScheduler();
    } catch (error) {
      await this.markCleanupFailed(operation, error);
    }
  }

  async markCleanupFailed(operation, error) {
    await this.withStateLock(async () => {
      operation.state = "cleanup_failed";
      operation.stage = "cleanup";
      operation.cleanupPending = true;
      operation.error = {
        code: "CLEANUP_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
      operation.updatedAt = this.now();
      await this.persistLocked();
    });
  }

  async cleanupSession(operation, sessionId) {
    const result = await this.deleteSession(sessionId);
    if (result?.isError) throw new Error(resultText(result) || "session cleanup failed");
    if (this.core.listSessions().some((session) => session.sessionId === sessionId)) {
      throw new Error("session cleanup returned but the session is still tracked");
    }
    operation.cleanupPending = false;
  }

  sweepExpiredLocked() {
    const now = this.now();
    let changed = false;
    const waiting = [];
    for (const operationId of this.queue) {
      const operation = this.operations.get(operationId);
      if (!operation || operation.state !== "queued") {
        changed = true;
        continue;
      }
      if (now - operation.lastHeartbeatAt >= this.queueHeartbeatMs) {
        operation.state = "expired";
        operation.stage = "finished";
        operation.updatedAt = now;
        operation.args = null;
        operation.error = {
          code: "QUEUE_HEARTBEAT_EXPIRED",
          message: `no status heartbeat was received for ${this.queueHeartbeatMs} ms`,
          retryable: true,
        };
        changed = true;
        continue;
      }
      waiting.push(operationId);
    }
    this.queue = waiting;
    if (this.pruneTerminalsLocked()) changed = true;
    return changed;
  }

  pruneTerminalsLocked() {
    const now = this.now();
    const terminal = [...this.operations.values()]
      .filter((operation) => CREATE_TERMINAL_STATES.has(operation.state))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const remove = new Set(
      terminal
        .filter((operation, index) => now - operation.updatedAt > this.terminalRetentionMs || index >= this.maxTerminalOperations)
        .map((operation) => operation.id),
    );
    for (const operationId of remove) {
      const operation = this.operations.get(operationId);
      this.operations.delete(operationId);
      if (operation && this.clientRequests.get(operation.clientRequestId) === operationId) {
        this.clientRequests.delete(operation.clientRequestId);
      }
    }
    return remove.size > 0;
  }

  async withStateLock(callback) {
    const previous = this.stateTail;
    let release;
    this.stateTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  trackBackground(promise) {
    void promise.catch((error) => {
      this.persistenceError = error instanceof Error ? error : new Error(String(error));
    });
  }

  serializeOperation(operation) {
    return {
      id: operation.id,
      clientRequestId: operation.clientRequestId,
      inputHash: operation.inputHash,
      state: operation.state,
      stage: operation.stage,
      enqueuedAt: operation.enqueuedAt,
      startedAt: operation.startedAt,
      updatedAt: operation.updatedAt,
      lastHeartbeatAt: operation.lastHeartbeatAt,
      cleanupPending: operation.cleanupPending,
      error: operation.error,
      args: operation.state === "queued" ? operation.args : null,
    };
  }

  async persistLocked() {
    try {
      await this.queueStore.save({
        version: QUEUE_STATE_VERSION,
        savedAt: this.now(),
        queue: [...this.queue],
        operations: [...this.operations.values()].map((operation) => this.serializeOperation(operation)),
      });
      this.persistenceError = null;
    } catch (error) {
      this.persistenceError = error instanceof Error ? error : new Error(String(error));
      throw this.persistenceError;
    }
  }

  async releaseOperationLease(operation) {
    if (!operation.leaseToken) return;
    await this.lease.release(operation.leaseToken);
    operation.leaseToken = null;
  }

  timeoutPrepare(operation) {
    if (this.prepareOperation !== operation || operation.state !== "starting") return;
    operation.state = "timed_out";
    operation.stage = "cleanup";
    operation.updatedAt = this.now();
    operation.cancelRequested = true;
    operation.cleanupPending = true;
    operation.error = {
      code: "OPERATION_TIMEOUT",
      message: `prepare exceeded ${this.prepareTimeoutMs} ms`,
      retryable: true,
    };
    operation.controller.abort();
  }

  async runPrepareOperation(operation) {
    try {
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
      const publicResult = sanitizePrepareResult(payload);
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
          publicResult,
        };
      }
      operation.result = publicResult;
      operation.state = "ready";
      operation.stage = "finished";
      operation.cleanupPending = false;
      operation.updatedAt = this.now();
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
      await this.releaseOperationLease(operation);
    }
  }

  statusPrepare(operationId) {
    if (!this.prepareOperation || this.prepareOperation.id !== operationId) {
      return errorContent(new Error(`unknown operationId: ${operationId}`), "UNKNOWN_OPERATION");
    }
    return successContent(basePublicOperation(this.prepareOperation, this.now));
  }

  async cancelPrepare(operationId) {
    if (!this.prepareOperation || this.prepareOperation.id !== operationId) {
      return errorContent(new Error(`unknown operationId: ${operationId}`), "UNKNOWN_OPERATION");
    }
    const operation = this.prepareOperation;
    if (["ready", "cancelled", "failed", "timed_out"].includes(operation.state)) {
      return successContent(basePublicOperation(operation, this.now));
    }
    operation.cancelRequested = true;
    operation.controller.abort();
    if (operation.timer) clearTimeout(operation.timer);
    operation.state = "cancelling";
    operation.stage = "cleanup";
    operation.cleanupPending = true;
    operation.updatedAt = this.now();
    return successContent(basePublicOperation(operation, this.now));
  }

  async afterCall(ctx, result) {
    if (ctx.toolName === "select_device") {
      const previousUdid = this.selectedUdid;
      this.selectedUdid = null;
      if (result.isError || ctx.args.platform !== "ios" || ctx.args.iosDeviceType !== "real") {
        this.prepared = null;
        return;
      }
      try {
        const selected = parseJsonText(result, "device selection");
        const udid = selected?.capabilities?.["appium:udid"];
        if (typeof udid === "string" && udid) this.selectedUdid = udid;
      } catch {
        this.selectedUdid = null;
      }
      if (!this.selectedUdid || this.selectedUdid !== previousUdid) this.prepared = null;
      return;
    }

    if (ctx.toolName === "appium_session_management" && ctx.args.action === "delete") {
      const operation = this.activeOperation;
      if (!operation || operation.state !== "ready") return;
      if (this.core.listSessions().some((session) => session.ownership === "owned")) return;
      try {
        await this.releaseOperationLease(operation);
        await this.withStateLock(async () => {
          operation.sessionId = null;
          operation.result = null;
          operation.args = null;
          operation.state = "closed";
          operation.stage = "finished";
          operation.updatedAt = this.now();
          this.activeOperation = null;
          await this.persistLocked();
        });
        this.kickScheduler();
      } catch (error) {
        await this.markCleanupFailed(operation, error);
      }
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);

    const prepare = this.prepareOperation;
    if (prepare && ["starting", "cancelling"].includes(prepare.state)) {
      prepare.cancelRequested = true;
      prepare.controller.abort();
      if (prepare.timer) clearTimeout(prepare.timer);
      if (prepare.promise) {
        await Promise.race([
          prepare.promise.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, this.cleanupTimeoutMs).unref()),
        ]);
      }
    }

    const operation = this.activeOperation;
    if (operation) {
      operation.cancelRequested = true;
      operation.controller?.abort();
      if (operation.timer) clearTimeout(operation.timer);
      if (operation.sessionId) {
        try {
          await this.cleanupSession(operation, operation.sessionId);
          await this.releaseOperationLease(operation);
        } catch (error) {
          await this.markCleanupFailed(operation, error);
          return;
        }
      } else if (operation.promise) {
        await Promise.race([
          operation.promise.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, this.cleanupTimeoutMs).unref()),
        ]);
      }
      if (!this.core.listSessions().some((session) => session.ownership === "owned")) {
        await this.releaseOperationLease(operation);
        await this.withStateLock(async () => {
          operation.sessionId = null;
          operation.result = null;
          operation.args = null;
          operation.state = "interrupted";
          operation.stage = "finished";
          operation.cleanupPending = false;
          operation.updatedAt = this.now();
          operation.error = {
            code: "BRIDGE_SHUTDOWN",
            message: "the bridge stopped before the session finished",
            retryable: true,
          };
          this.activeOperation = null;
          await this.persistLocked();
        });
      }
    } else if (this.initialized) {
      await this.withStateLock(async () => this.persistLocked());
    }
  }

  async destroy() {
    await this.shutdown();
  }
}
