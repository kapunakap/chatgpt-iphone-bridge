import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CellularBrowserPlugin } from "./cellular-browser-plugin.mjs";
import { DeviceLease } from "./device-lease.mjs";

function fakeClient() {
  return {
    on() {},
    start() {},
    async close() {},
    status() {
      return { relayConnected: false, deviceOnline: false, secureReady: false };
    },
  };
}

function tokenFactory(prefix) {
  let number = 0;
  return () => `${prefix}-${++number}`;
}

test("unmapped cellular browser conservatively excludes the whole USB pool", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-cellular-usb-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_UDID;
  delete process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_UDID;
  t.after(() => {
    if (previous == null) delete process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_UDID;
    else process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_UDID = previous;
  });

  const usb = new DeviceLease({ root, makeId: tokenFactory("usb") });
  const usbToken = await usb.acquire("create", "device:b");
  t.after(() => usb.release(usbToken));
  const plugin = new CellularBrowserPlugin({
    client: fakeClient(),
    lease: new DeviceLease({ root, makeId: tokenFactory("cellular") }),
    schedule() {},
  });
  await assert.rejects(
    plugin.startSession({ initialUrl: "https://example.test/", allowedOrigins: ["https://example.test"] }),
    /already active/,
  );
});

test("mapped cellular browser excludes only its matching USB device", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iphone-bridge-cellular-map-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_UDID;
  process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_UDID = "device:a";
  t.after(() => {
    if (previous == null) delete process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_UDID;
    else process.env.IPHONE_BRIDGE_CELLULAR_DEVICE_UDID = previous;
  });

  const usbB = new DeviceLease({ root, makeId: tokenFactory("usb-b") });
  const usbBToken = await usbB.acquire("create", "device:b");
  const plugin = new CellularBrowserPlugin({
    client: fakeClient(),
    lease: new DeviceLease({ root, makeId: tokenFactory("cellular") }),
    schedule() {},
  });
  const operation = await plugin.startSession({
    initialUrl: "https://example.test/",
    allowedOrigins: ["https://example.test"],
  });
  assert.equal(operation.state, "awaiting_device");
  await plugin.closeSession("closed", { operationId: operation.operationId });
  await usbB.release(usbBToken);

  const usbA = new DeviceLease({ root, makeId: tokenFactory("usb-a") });
  const usbAToken = await usbA.acquire("create", "device:a");
  const blockedPlugin = new CellularBrowserPlugin({
    client: fakeClient(),
    lease: new DeviceLease({ root, makeId: tokenFactory("blocked") }),
    schedule() {},
  });
  await assert.rejects(
    blockedPlugin.startSession({ initialUrl: "https://example.test/", allowedOrigins: ["https://example.test"] }),
    /already active/,
  );
  await usbA.release(usbAToken);
});
