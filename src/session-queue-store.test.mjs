import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionQueueStore } from "./session-queue-store.mjs";

test("queue store saves atomically with private permissions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-queue-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionQueueStore({ root, makeId: () => "temporary" });
  const payload = { version: 1, savedAt: 1, queue: [], operations: [] };
  await store.save(payload);
  assert.deepEqual(await store.load(), payload);
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(root, "session-queue.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(root), ["session-queue.json"]);
});

test("queue store distinguishes missing state from invalid JSON", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-queue-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionQueueStore({ root });
  assert.equal(await store.load(), null);
  await fs.writeFile(path.join(root, "session-queue.json"), "not json", { mode: 0o600 });
  await assert.rejects(store.load(), /Invalid JSON/);
});
