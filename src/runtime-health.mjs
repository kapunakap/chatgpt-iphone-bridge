export const CANONICAL_RUNTIME_ALIAS = "local-iphone-bridge";

export function normalizeRuntimeTarget(value) {
  return String(value ?? "").replace(/^['"]|['"]$/g, "");
}

export function assessRuntime(status, expectedLauncher) {
  const target = normalizeRuntimeTarget(status?.process?.target_value);
  const expectedLaunchers = Array.isArray(expectedLauncher) ? expectedLauncher : [expectedLauncher];
  const checks = {
    process_running: status?.process_running === true,
    healthy: status?.healthy === true,
    ready: status?.ready === true,
    target_matches: expectedLaunchers.includes(target),
  };
  const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    alias: CANONICAL_RUNTIME_ALIAS,
    state: failures.length === 0 ? "healthy" : "unhealthy",
    checks,
    failures,
    target,
  };
}

export function monitorTransition(previous, current) {
  if (!previous) return current.state === "unhealthy" ? "became_unhealthy" : null;
  if (previous.state === current.state) return null;
  return current.state === "healthy" ? "recovered" : "became_unhealthy";
}
