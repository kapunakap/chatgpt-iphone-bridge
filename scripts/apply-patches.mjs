#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const requestedRoot = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : packageRoot;
const installRoot = [requestedRoot, packageRoot].find((candidate) =>
  fs.existsSync(path.join(candidate, "node_modules", "appium-mcp", "package.json")),
);
if (!installRoot) {
  throw new Error("appium-mcp must be installed before applying the bridge patches");
}
const patchDir = path.relative(installRoot, path.join(packageRoot, "patches")) || "patches";
const patchPackageCli = require.resolve("patch-package");
const result = spawnSync(process.execPath, [patchPackageCli, "--patch-dir", patchDir, "--error-on-fail"], {
  cwd: installRoot,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
