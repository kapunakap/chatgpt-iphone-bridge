import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function defaultArtifactRoot() {
  return (
    process.env.APPIUM_BRIDGE_ARTIFACT_ROOT ??
    path.join(os.homedir(), "Library", "Application Support", "chatgpt-iphone-bridge")
  );
}

export class SessionQueueStore {
  constructor(options = {}) {
    this.root = options.root ?? path.join(defaultArtifactRoot(), "runtime");
    this.filePath = options.filePath ?? path.join(this.root, "session-queue.json");
    this.makeId = options.makeId ?? randomUUID;
  }

  async load() {
    try {
      return JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in persisted iPhone queue: ${this.filePath}`);
      }
      throw error;
    }
  }

  async save(payload) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${this.makeId()}`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await fs.chmod(temporaryPath, 0o600);
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}
