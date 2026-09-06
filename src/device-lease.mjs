import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { defaultArtifactRoot } from "./session-queue-store.mjs";

const DEFAULT_RESOURCE = "pool";
const ARBITRATION_LOCK = "lease-arbitration.lock";
const LEGACY_LOCK = "session.lock";
const ARBITRATION_RETRY_MS = 10;
const ARBITRATION_MAX_ATTEMPTS = 500;
const INCOMPLETE_OWNER_GRACE_MS = 5_000;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeResource(resource) {
  if (typeof resource !== "string" || !resource.trim()) return DEFAULT_RESOURCE;
  return resource.trim();
}

function resourcesConflict(left, right) {
  if (left === DEFAULT_RESOURCE || right === DEFAULT_RESOURCE) return true;
  return left === right;
}

export class DeviceLease {
  constructor(options = {}) {
    this.root = options.root ?? path.join(defaultArtifactRoot(), "runtime");
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? randomUUID;
    this.tokensByResource = new Map();
    this.resourcesByToken = new Map();
  }

  resourceKey(resource) {
    return createHash("sha256").update(normalizeResource(resource)).digest("hex");
  }

  lockPathFor(resource) {
    return path.join(this.root, `device-${this.resourceKey(resource)}.lock`);
  }

  async acquire(kind, resource = DEFAULT_RESOURCE) {
    const normalizedResource = normalizeResource(resource);
    const currentToken = this.tokensByResource.get(normalizedResource);
    if (currentToken) return currentToken;

    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);

    return await this.withArbitration(async () => {
      const repeatedToken = this.tokensByResource.get(normalizedResource);
      if (repeatedToken) return repeatedToken;

      const owners = await this.activeOwnersLocked();
      const conflicting = owners.find((entry) => resourcesConflict(normalizedResource, entry.resource));
      if (conflicting) {
        throw new Error(
          `device operation ${conflicting.owner?.kind ?? "unknown"} is already active in process ${conflicting.owner?.pid ?? "unknown"}`,
        );
      }

      const lockPath = this.lockPathFor(normalizedResource);
      const token = this.makeId();
      await fs.mkdir(lockPath, { mode: 0o700 });
      try {
        await fs.writeFile(
          path.join(lockPath, "owner.json"),
          `${JSON.stringify({ token, pid: this.pid, kind, resource: normalizedResource, startedAt: this.now() })}\n`,
          { mode: 0o600 },
        );
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }

      this.tokensByResource.set(normalizedResource, token);
      this.resourcesByToken.set(token, { resource: normalizedResource, lockPath });
      return token;
    });
  }

  async activeOwnersLocked() {
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    const owners = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ARBITRATION_LOCK) continue;
      if (entry.name !== LEGACY_LOCK && !/^device-[a-f0-9]{64}\.lock$/.test(entry.name)) continue;
      const lockPath = path.join(this.root, entry.name);
      const owner = await this.readOwnerAt(lockPath);
      if (owner && processIsAlive(owner.pid)) {
        owners.push({
          lockPath,
          owner,
          resource: entry.name === LEGACY_LOCK ? DEFAULT_RESOURCE : normalizeResource(owner.resource),
        });
        continue;
      }
      if (!owner && (await this.isFreshIncompleteLock(lockPath))) {
        owners.push({ lockPath, owner: { kind: "unknown", pid: "unknown" }, resource: DEFAULT_RESOURCE });
        continue;
      }
      await this.removeStaleLock(lockPath);
    }
    return owners;
  }

  async isFreshIncompleteLock(lockPath) {
    try {
      const stat = await fs.stat(lockPath);
      return this.now() - stat.mtimeMs < INCOMPLETE_OWNER_GRACE_MS;
    } catch {
      return false;
    }
  }

  async removeStaleLock(lockPath) {
    const stalePath = `${lockPath}.stale-${this.makeId()}`;
    try {
      await fs.rename(lockPath, stalePath);
      await fs.rm(stalePath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async readOwnerAt(lockPath) {
    try {
      return JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
    } catch {
      return null;
    }
  }

  async readOwner(resource = DEFAULT_RESOURCE) {
    return await this.readOwnerAt(this.lockPathFor(resource));
  }

  async withArbitration(callback) {
    const gatePath = path.join(this.root, ARBITRATION_LOCK);
    const token = this.makeId();
    for (let attempt = 0; attempt < ARBITRATION_MAX_ATTEMPTS; attempt += 1) {
      try {
        await fs.mkdir(gatePath, { mode: 0o700 });
        try {
          await fs.writeFile(
            path.join(gatePath, "owner.json"),
            `${JSON.stringify({ token, pid: this.pid, kind: "arbitration", startedAt: this.now() })}\n`,
            { mode: 0o600 },
          );
        } catch (error) {
          await fs.rm(gatePath, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        try {
          return await callback();
        } finally {
          const owner = await this.readOwnerAt(gatePath);
          if (owner?.token === token) await fs.rm(gatePath, { recursive: true, force: true });
        }
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const owner = await this.readOwnerAt(gatePath);
        if (owner && !processIsAlive(owner.pid)) {
          await this.removeStaleLock(gatePath);
          continue;
        }
        if (!owner && !(await this.isFreshIncompleteLock(gatePath))) {
          await this.removeStaleLock(gatePath);
          continue;
        }
        await delay(ARBITRATION_RETRY_MS);
      }
    }
    throw new Error("Unable to acquire device lease arbitration lock");
  }

  async release(token = this.resourcesByToken.keys().next().value) {
    if (!token) return;
    const entry = this.resourcesByToken.get(token);
    if (!entry) return;
    const owner = await this.readOwnerAt(entry.lockPath);
    if (owner?.token === token) {
      await fs.rm(entry.lockPath, { recursive: true, force: true });
    }
    this.tokensByResource.delete(entry.resource);
    this.resourcesByToken.delete(token);
  }
}

export { DEFAULT_RESOURCE, resourcesConflict };
