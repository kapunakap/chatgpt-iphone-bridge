#!/usr/bin/env node

import { startIphoneBridgeServer } from "../src/bridge-server.mjs";

try {
  await startIphoneBridgeServer();
} catch (error) {
  console.error(`Local iPhone bridge failed to start: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
}
