import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_APPIUM_MCP_VERSION = "1.92.11";
const require = createRequire(import.meta.url);
const packagePath = require.resolve("appium-mcp/package.json");
const packageRoot = path.dirname(packagePath);
const installedVersion = require(packagePath).version;

if (installedVersion !== EXPECTED_APPIUM_MCP_VERSION) {
  throw new Error(
    `chatgpt-iphone-bridge requires appium-mcp@${EXPECTED_APPIUM_MCP_VERSION}; found ${installedVersion}`,
  );
}

async function importPrivate(relativePath) {
  return await import(pathToFileURL(path.join(packageRoot, relativePath)).href);
}

const createModule = await importPrivate("dist/tools/session/create-session.js");
const deleteModule = await importPrivate("dist/tools/session/delete-session.js");

export const createSessionAction = createModule.createSessionAction;
export const deleteSessionAction = deleteModule.deleteSessionAction;
export { EXPECTED_APPIUM_MCP_VERSION };
