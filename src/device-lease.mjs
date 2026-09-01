import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function defaultArtifactRoot() {
  return (
    process.env.APPIUM_BRIDGE_ARTIFACT_ROOT ??
    path.join(os.homedir(), "Library", "Application Support", "chatgpt-iphone-bridge")
  );
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
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
    if (!resource) return "default";
    return createHash("sha256").update(resource).digest("hex");
  }

  lockPathFor(resource) {
    return path.join(this.root, `device-${this.resourceKey(resource)}.lock`);
  }

  async acquire(kind, resource) {
    const resourceKey = this.resourceKey(resource);
    const currentToken = this.tokensByResource.get(resourceKey);
    if (currentToken) return currentToken;
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
    const lockPath = this.lockPathFor(resource);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
        const token = this.makeId();
        await fs.writeFile(
          path.join(lockPath, "owner.json"),
          `${JSON.stringify({ token, pid: this.pid, kind, startedAt: this.now() })}\n`,
          { mode: 0o600 },
        );
        this.tokensByResource.set(resourceKey, token);
        this.resourcesByToken.set(token, { resourceKey, lockPath });
        return token;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const owner = await this.readOwnerAt(lockPath);
        if (owner && processIsAlive(owner.pid)) {
          throw new Error(`device operation ${owner.kind ?? "unknown"} is already active in process ${owner.pid}`);
        }
        const stalePath = `${lockPath}.stale-${this.makeId()}`;
        try {
          await fs.rename(lockPath, stalePath);
          await fs.rm(stalePath, { recursive: true, force: true });
        } catch (renameError) {
          if (renameError?.code !== "ENOENT") throw renameError;
        }
      }
    }
    throw new Error("Unable to acquire the device operation lease");
  }

  async readOwnerAt(lockPath) {
    try {
      return JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
    } catch {
      return null;
    }
  }

  async readOwner(resource) {
    return await this.readOwnerAt(this.lockPathFor(resource));
  }

  async release(token = this.resourcesByToken.keys().next().value) {
    if (!token) return;
    const entry = this.resourcesByToken.get(token);
    if (!entry) return;
    const owner = await this.readOwnerAt(entry.lockPath);
    if (owner?.token !== token) {
      this.tokensByResource.delete(entry.resourceKey);
      this.resourcesByToken.delete(token);
      return;
    }
    await fs.rm(entry.lockPath, { recursive: true, force: true });
    this.tokensByResource.delete(entry.resourceKey);
    this.resourcesByToken.delete(token);
  }
}
