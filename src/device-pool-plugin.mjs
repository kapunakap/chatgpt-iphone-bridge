import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { AsyncSessionPlugin } from "./async-session-plugin.mjs";
import { DeviceLease } from "./device-lease.mjs";
import { defaultArtifactRoot, SessionQueueStore } from "./session-queue-store.mjs";

const POOL_STATE_VERSION = 1;

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
  clientRequestId: z.string().min(1).max(200).optional(),
  operationId: z.string().min(1).optional(),
});

const poolStateSchema = z.object({
  version: z.literal(POOL_STATE_VERSION),
  devices: z.array(z.string().min(1)).max(128),
});

function resultText(result) {
  return result?.content?.find((item) => item.type === "text")?.text ?? "";
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

function parseCapabilities(value) {
  let parsed = value;
  if (typeof value === "string") parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("capabilities must be a JSON object");
  }
  return { ...parsed };
}

function parseSelectedUdid(result) {
  if (result?.isError) return null;
  try {
    const selected = JSON.parse(resultText(result));
    const udid = selected?.capabilities?.["appium:udid"];
    return typeof udid === "string" && udid ? udid : null;
  } catch {
    return null;
  }
}

function sessionBelongsToDevice(session, udid) {
  const capabilities = session?.capabilities;
  return capabilities?.["appium:udid"] === udid || capabilities?.udid === udid;
}

function scopedCore(core, udid) {
  return new Proxy(core, {
    get(target, property, receiver) {
      if (property === "listSessions") {
        return () => target.listSessions().filter((session) => sessionBelongsToDevice(session, udid));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function queueKey(udid) {
  return createHash("sha256").update(udid).digest("hex");
}

export function deviceQueuePath(runtimeRoot, udid) {
  return path.join(runtimeRoot, `session-queue-${queueKey(udid)}.json`);
}

class ScopedDeviceLease {
  constructor(shared, udid) {
    this.shared = shared;
    this.udid = udid;
  }

  async acquire(kind) {
    const tokens = [];
    try {
      tokens.push(await this.shared.acquire(kind, `device:${this.udid}`));
      if (kind === "prepare") {
        tokens.push(await this.shared.acquire(kind, "shared:wda-preparation"));
      }
      return tokens;
    } catch (error) {
      await Promise.allSettled(tokens.reverse().map((token) => this.shared.release(token)));
      throw error;
    }
  }

  async release(tokens) {
    const list = Array.isArray(tokens) ? [...tokens].reverse() : tokens ? [tokens] : [];
    const results = await Promise.allSettled(list.map((token) => this.shared.release(token)));
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "one or more scoped device leases failed to release");
  }
}

export class DevicePoolPlugin {
  constructor(options = {}) {
    this.name = "openai-local-ios-device-pool";
    this.version = "0.2.0-beta.4";
    this.runtimeRoot = options.runtimeRoot ?? path.join(defaultArtifactRoot(), "runtime");
    this.manifestPath = options.manifestPath ?? path.join(this.runtimeRoot, "device-pool.json");
    this.sharedLease = options.lease ?? new DeviceLease({ root: this.runtimeRoot });
    this.makeId = options.makeId ?? randomUUID;
    this.workerFactory = options.workerFactory ?? ((workerOptions) => new AsyncSessionPlugin(workerOptions));
    this.queueStoreFactory =
      options.queueStoreFactory ??
      ((udid) => new SessionQueueStore({ root: this.runtimeRoot, filePath: deviceQueuePath(this.runtimeRoot, udid) }));
    this.workerOptions = options.workerOptions ?? options;
    this.core = null;
    this.knownUdids = new Set();
    this.workers = new Map();
    this.workerPromises = new Map();
    this.legacyWorker = null;
    this.initialized = false;
    this.initializationPromise = null;
    this.shuttingDown = false;
  }

  register(registry, core) {
    this.core = core;
    registry.addTool({
      name: "appium_prepare_ios_real_device_async",
      description:
        "Prepare one selected real iPhone or iPad without blocking the MCP request. Preparation is serialized across the pool while unrelated active Safari sessions may continue. Poll or cancel with operationId.",
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
        "Request a persistent FIFO Safari-session spot for one selected real iPhone or iPad. Same-device requests stay FIFO while different devices may run concurrently. Start with a unique clientRequestId and udid when the pool has multiple selected devices, then poll or cancel with operationId.",
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
  }

  async ensureInitialized() {
    if (this.initialized) return;
    this.initializationPromise ??= this.initializePool();
    await this.initializationPromise;
    this.initialized = true;
  }

  async initializePool() {
    await fs.mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(this.runtimeRoot, 0o700);
    const manifest = await this.loadManifest();
    for (const udid of manifest.devices) this.knownUdids.add(udid);

    this.legacyWorker = this.workerFactory({
      ...this.childWorkerOptions(),
      lease: this.sharedLease,
      queueStore: new SessionQueueStore({ root: this.runtimeRoot }),
    });
    if (this.core) await this.legacyWorker.initialize({ core: this.core });

    for (const udid of this.knownUdids) await this.ensureWorker(udid, { persist: false });
  }

  childWorkerOptions() {
    const excluded = new Set([
      "runtimeRoot",
      "manifestPath",
      "lease",
      "makeId",
      "workerFactory",
      "queueStoreFactory",
      "workerOptions",
    ]);
    return Object.fromEntries(Object.entries(this.workerOptions).filter(([key]) => !excluded.has(key)));
  }

  async loadManifest() {
    try {
      return poolStateSchema.parse(JSON.parse(await fs.readFile(this.manifestPath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return { version: POOL_STATE_VERSION, devices: [] };
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new Error(`Persisted iOS device pool is invalid or unsupported: ${this.manifestPath}`);
      }
      throw error;
    }
  }

  async saveManifest() {
    await fs.mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.manifestPath}.tmp-${process.pid}-${this.makeId()}`;
    try {
      await fs.writeFile(
        temporaryPath,
        `${JSON.stringify({ version: POOL_STATE_VERSION, devices: [...this.knownUdids].sort() }, null, 2)}\n`,
        { mode: 0o600 },
      );
      await fs.chmod(temporaryPath, 0o600);
      await fs.rename(temporaryPath, this.manifestPath);
      await fs.chmod(this.manifestPath, 0o600);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async ensureWorker(udid, { persist = true } = {}) {
    if (this.workers.has(udid)) return this.workers.get(udid);
    if (this.workerPromises.has(udid)) return await this.workerPromises.get(udid);
    const promise = (async () => {
      if (persist && !this.knownUdids.has(udid)) {
        this.knownUdids.add(udid);
        try {
          await this.saveManifest();
        } catch (error) {
          this.knownUdids.delete(udid);
          throw error;
        }
      }
      const worker = this.workerFactory({
        ...this.childWorkerOptions(),
        lease: new ScopedDeviceLease(this.sharedLease, udid),
        queueStore: this.queueStoreFactory(udid),
      });
      worker.selectedUdid = udid;
      if (this.core) await worker.initialize({ core: scopedCore(this.core, udid) });
      this.workers.set(udid, worker);
      return worker;
    })();
    this.workerPromises.set(udid, promise);
    try {
      return await promise;
    } finally {
      this.workerPromises.delete(udid);
    }
  }

  async executeTool(kind, args) {
    await this.ensureInitialized();
    if (this.shuttingDown) return errorContent(new Error("bridge shutdown is in progress"), "SHUTTING_DOWN");

    if (args.action !== "start") {
      if (!args.operationId) return errorContent(new Error("operationId is required"), "INVALID_ARGUMENTS");
      const worker = this.workerForOperation(kind, args.operationId);
      if (!worker) return errorContent(new Error(`unknown operationId: ${args.operationId}`), "UNKNOWN_OPERATION");
      const childArgs = { action: args.action, operationId: args.operationId };
      return await worker.executeTool(kind, childArgs);
    }

    if (kind === "prepare") {
      if (!args.udid) return errorContent(new Error("udid is required for prepare start"), "INVALID_ARGUMENTS");
      if (!this.knownUdids.has(args.udid)) {
        return errorContent(new Error("select this real iOS device before preparation"), "INVALID_ARGUMENTS");
      }
      const worker = await this.ensureWorker(args.udid, { persist: false });
      worker.selectedUdid = args.udid;
      return await worker.executeTool("prepare", args);
    }

    let capabilities;
    try {
      if (args.capabilities == null) throw new Error("capabilities are required for create start");
      capabilities = parseCapabilities(args.capabilities);
    } catch (error) {
      return errorContent(error, "INVALID_ARGUMENTS");
    }
    const explicitUdid = capabilities["appium:udid"];
    if (args.udid && explicitUdid && args.udid !== explicitUdid) {
      return errorContent(new Error("top-level UDID does not match the capability UDID"), "INVALID_ARGUMENTS");
    }
    const udid = args.udid ?? explicitUdid ?? (this.knownUdids.size === 1 ? [...this.knownUdids][0] : null);
    if (!udid) {
      return errorContent(new Error("udid is required when more than one iOS device is selected"), "INVALID_ARGUMENTS");
    }
    if (!this.knownUdids.has(udid)) {
      return errorContent(new Error("select this real iOS device before session creation"), "INVALID_ARGUMENTS");
    }
    capabilities["appium:udid"] = udid;
    const worker = await this.ensureWorker(udid, { persist: false });
    worker.selectedUdid = udid;
    return await worker.executeTool("create", {
      action: "start",
      capabilities,
      clientRequestId: args.clientRequestId,
    });
  }

  workerForOperation(kind, operationId) {
    if (kind === "create") {
      if (this.legacyWorker?.operations?.has(operationId)) return this.legacyWorker;
      for (const worker of this.workers.values()) {
        if (worker.operations?.has(operationId)) return worker;
      }
      return null;
    }
    if (this.legacyWorker?.prepareOperation?.id === operationId) return this.legacyWorker;
    for (const worker of this.workers.values()) {
      if (worker.prepareOperation?.id === operationId) return worker;
    }
    return null;
  }

  async afterCall(ctx, result) {
    await this.ensureInitialized();
    if (ctx.toolName === "select_device") {
      if (ctx.args.platform !== "ios" || ctx.args.iosDeviceType !== "real") return;
      const udid = parseSelectedUdid(result);
      if (!udid) return;
      const worker = await this.ensureWorker(udid);
      worker.selectedUdid = udid;
      return;
    }

    if (ctx.toolName === "appium_session_management" && ctx.args.action === "delete") {
      const results = await Promise.allSettled([...this.workers.values()].map((worker) => worker.afterCall(ctx, result)));
      const failures = results.filter((entry) => entry.status === "rejected").map((entry) => entry.reason);
      if (failures.length > 0) throw new AggregateError(failures, "one or more device workers failed delete cleanup");
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    await this.ensureInitialized();
    const workers = [...this.workers.values(), ...(this.legacyWorker ? [this.legacyWorker] : [])];
    const results = await Promise.allSettled(workers.map((worker) => worker.shutdown()));
    const failures = results.filter((entry) => entry.status === "rejected").map((entry) => entry.reason);
    if (failures.length > 0) throw new AggregateError(failures, "one or more iOS device workers failed to shut down");
  }

  async destroy() {
    await this.shutdown();
  }
}

export { POOL_STATE_VERSION, ScopedDeviceLease };
