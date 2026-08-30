import assert from "node:assert/strict";
import test from "node:test";

import { assessRuntime, monitorTransition } from "./runtime-health.mjs";

const launcher = "/repo/scripts/appium-mcp-current.sh";

test("runtime assessment requires all four canonical health signals", () => {
  const healthy = assessRuntime(
    {
      process_running: true,
      healthy: true,
      ready: true,
      process: { target_value: `"${launcher}"` },
    },
    launcher,
  );
  assert.equal(healthy.state, "healthy");
  assert.deepEqual(healthy.failures, []);

  const wrongTarget = assessRuntime(
    { process_running: true, healthy: true, ready: true, process: { target_value: '"/wrong"' } },
    launcher,
  );
  assert.equal(wrongTarget.state, "unhealthy");
  assert.deepEqual(wrongTarget.failures, ["target_matches"]);
});

test("monitor alerts only on unhealthy and recovery transitions", () => {
  assert.equal(monitorTransition(null, { state: "healthy" }), null);
  assert.equal(monitorTransition(null, { state: "unhealthy" }), "became_unhealthy");
  assert.equal(monitorTransition({ state: "unhealthy" }, { state: "unhealthy" }), null);
  assert.equal(monitorTransition({ state: "unhealthy" }, { state: "healthy" }), "recovered");
});
