#!/usr/bin/env node

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const reportPath = process.argv[2];
if (!reportPath) throw new Error("Usage: node scripts/check-audit.mjs <npm-audit.json>");
const baselinePath = fileURLToPath(new URL("../security/audit-baseline.json", import.meta.url));
const [baseline, report] = await Promise.all([
  fs.readFile(baselinePath, "utf8").then(JSON.parse),
  fs.readFile(reportPath, "utf8").then(JSON.parse),
]);

if (Date.parse(baseline.reviewBy) < Date.now()) {
  throw new Error(`Security advisory baseline expired on ${baseline.reviewBy}`);
}

const actualPackages = Object.fromEntries(
  Object.entries(report.vulnerabilities ?? {}).map(([name, value]) => [name, value.severity]),
);
if (JSON.stringify(actualPackages) !== JSON.stringify(baseline.packages)) {
  throw new Error(
    `Dependency advisory set changed. Expected ${JSON.stringify(baseline.packages)}, received ${JSON.stringify(actualPackages)}`,
  );
}

const counts = report.metadata?.vulnerabilities ?? {};
for (const [severity, expected] of Object.entries(baseline.counts)) {
  if (counts[severity] !== expected) {
    throw new Error(`Expected ${severity}=${expected}, received ${counts[severity]}`);
  }
}
console.log(`AUDIT_BASELINE_OK=1 reviewBy=${baseline.reviewBy}`);
