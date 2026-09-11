import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { defaultArtifactRoot, SessionQueueStore } from "../src/session-queue-store.mjs";

const runtimeRoot = path.join(defaultArtifactRoot(), "runtime");
const manifestPath = path.join(runtimeRoot, "device-pool.json");

function key(udid) {
  return createHash("sha256").update(udid).digest("hex");
}

function queuePath(udid) {
  return path.join(runtimeRoot, `session-queue-${key(udid)}.json`);
}

function validateState(state, label) {
  if (state == null) return;
  if (state.version !== 1 || !Array.isArray(state.queue) || !Array.isArray(state.operations)) {
    throw new Error(`Persisted ${label} queue is invalid or unsupported`);
  }
}

function summarize(label, state) {
  validateState(state, label);
  if (state == null) {
    console.log(`${label} queue_depth=0 active_operation=none retained_terminal_operations=0`);
    return;
  }
  const active = state.operations.find((operation) =>
    new Set(["starting", "ready", "cancelling", "cleanup_failed"]).has(operation.state),
  );
  const terminalCount = state.operations.filter((operation) =>
    new Set(["cancelled", "closed", "expired", "failed", "interrupted", "timed_out"]).has(operation.state),
  ).length;
  console.log(
    `${label} saved_at=${new Date(state.savedAt).toISOString()} queue_depth=${state.queue.length} active_operation=${active ? active.id : "none"} retained_terminal_operations=${terminalCount}`,
  );
  if (active) console.log(`${label} active_state=${active.state}`);
  const operations = new Map(state.operations.map((operation) => [operation.id, operation]));
  for (const [index, operationId] of state.queue.entries()) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`Queue entry ${operationId} has no operation record`);
    console.log(
      `${label} position=${index + 1} operation_id=${operation.id} state=${operation.state} enqueued_at=${new Date(operation.enqueuedAt).toISOString()}`,
    );
  }
}

let manifest = null;
try {
  manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (manifest && (manifest.version !== 1 || !Array.isArray(manifest.devices))) {
  throw new Error("Persisted iOS device pool is invalid or unsupported");
}

const legacy = await new SessionQueueStore({ root: runtimeRoot }).load();
if (!manifest) {
  summarize("legacy", legacy);
  process.exit(0);
}

console.log(`pool_devices=${manifest.devices.length}`);
summarize("legacy", legacy);
for (const [index, udid] of manifest.devices.entries()) {
  const state = await new SessionQueueStore({ root: runtimeRoot, filePath: queuePath(udid) }).load();
  summarize(`device_${index + 1}_${key(udid).slice(0, 10)}`, state);
}
