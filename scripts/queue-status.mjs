import { SessionQueueStore } from "../src/session-queue-store.mjs";

const store = new SessionQueueStore();
const state = await store.load();

if (state == null) {
  console.log("queue_depth=0");
  console.log("active_operation=none");
  process.exit(0);
}

if (state.version !== 1 || !Array.isArray(state.queue) || !Array.isArray(state.operations)) {
  throw new Error("Persisted iPhone queue is invalid or unsupported");
}

const operations = new Map(state.operations.map((operation) => [operation.id, operation]));
const active = state.operations.find((operation) =>
  new Set(["starting", "ready", "cancelling", "cleanup_failed"]).has(operation.state),
);

console.log(`saved_at=${new Date(state.savedAt).toISOString()}`);
console.log(`queue_depth=${state.queue.length}`);
console.log(`active_operation=${active ? active.id : "none"}`);
if (active) console.log(`active_state=${active.state}`);

for (const [index, operationId] of state.queue.entries()) {
  const operation = operations.get(operationId);
  if (!operation) throw new Error(`Queue entry ${operationId} has no operation record`);
  console.log(
    `position=${index + 1} operation_id=${operation.id} state=${operation.state} enqueued_at=${new Date(operation.enqueuedAt).toISOString()}`,
  );
}

const terminalCount = state.operations.filter((operation) =>
  new Set(["cancelled", "closed", "expired", "failed", "interrupted", "timed_out"]).has(operation.state),
).length;
console.log(`retained_terminal_operations=${terminalCount}`);
