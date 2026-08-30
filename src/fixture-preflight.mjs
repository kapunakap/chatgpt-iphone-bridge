export async function probeFixture(fixture, options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const response = await fetchImpl(fixture.url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    if (!body.includes(fixture.marker)) throw new Error(`marker ${fixture.marker} was not present`);
    return fixture;
  } finally {
    clearTimeout(timer);
  }
}

export async function chooseReachableFixture(primary, fallback, options = {}) {
  try {
    return { fixture: await probeFixture(primary, options), source: "controlled" };
  } catch (primaryError) {
    if (!fallback) {
      throw new Error(`Controlled fixture is unreachable and no HTTPS fallback is configured: ${primaryError.message}`);
    }
    if (new URL(fallback.url).protocol !== "https:") throw new Error("Fixture fallback must use HTTPS");
    try {
      return { fixture: await probeFixture(fallback, options), source: "fallback", primaryError: primaryError.message };
    } catch (fallbackError) {
      throw new Error(`Controlled fixture failed (${primaryError.message}); HTTPS fallback failed (${fallbackError.message})`);
    }
  }
}
