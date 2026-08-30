#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cache = fs.mkdtempSync(path.join(os.tmpdir(), "iphone-bridge-pack-cache-"));
try {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    env: { ...process.env, npm_config_cache: cache },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const report = JSON.parse(output)[0];
  const forbidden = report.files
    .map((file) => file.path)
    .filter(
      (file) =>
        file.includes("node_modules/") ||
        file.includes(".wrangler/") ||
        /\.(mobileprovision|provisionprofile|p12|cer|ipa|pem|key)$/.test(file) ||
        file.endsWith("runtime-api-key"),
    );
  if (forbidden.length) throw new Error(`package includes forbidden files: ${forbidden.join(", ")}`);
  if (report.unpackedSize > 5 * 1024 * 1024) throw new Error(`package is unexpectedly large: ${report.unpackedSize} bytes`);
  console.log(`PACKAGE_CONTENTS_OK=1 files=${report.entryCount} unpacked_bytes=${report.unpackedSize}`);
} finally {
  fs.rmSync(cache, { recursive: true, force: true });
}
