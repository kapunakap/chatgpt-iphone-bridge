import { randomUUID } from "node:crypto";
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
    this.lockPath = path.join(this.root, "session.lock");
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? randomUUID;
    this.ownerToken = null;
  }

  async acquire(kind) {
    if (this.ownerToken) return this.ownerToken;
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await fs.mkdir(this.lockPath, { mode: 0o700 });
        const token = this.makeId();
        await fs.writeFile(
          path.join(this.lockPath, "owner.json"),
          `${JSON.stringify({ token, pid: this.pid, kind, startedAt: this.now() })}\n`,
          { mode: 0o600 },
        );
        this.ownerToken = token;
        return token;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const owner = await this.readOwner();
        if (owner && processIsAlive(owner.pid)) {
          throw new Error(`iPhone operation ${owner.kind ?? "unknown"} is already active in process ${owner.pid}`);
        }
        const stalePath = `${this.lockPath}.stale-${this.makeId()}`;
        try {
          await fs.rename(this.lockPath, stalePath);
          await fs.rm(stalePath, { recursive: true, force: true });
        } catch (renameError) {
          if (renameError?.code !== "ENOENT") throw renameError;
        }
      }
    }
    throw new Error("Unable to acquire the iPhone operation lease");
  }

  async readOwner() {
    try {
      return JSON.parse(await fs.readFile(path.join(this.lockPath, "owner.json"), "utf8"));
    } catch {
      return null;
    }
  }

  async release(token = this.ownerToken) {
    if (!token) return;
    const owner = await this.readOwner();
    if (owner?.token !== token) {
      if (token === this.ownerToken) this.ownerToken = null;
      return;
    }
    await fs.rm(this.lockPath, { recursive: true, force: true });
    if (token === this.ownerToken) this.ownerToken = null;
  }
}
