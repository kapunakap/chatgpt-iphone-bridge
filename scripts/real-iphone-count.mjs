#!/usr/bin/env node

import { listAvailableRealIphones } from "../src/ios-device-state.mjs";

const devices = await listAvailableRealIphones();
console.log(devices.length);
