# ChatGPT iPhone Bridge

Control Mobile Safari on one USB-connected iPhone from ChatGPT through OpenAI Secure MCP Tunnel and Appium MCP.

This is an unofficial beta candidate. It opens no public inbound port and does not expose Appium directly to the internet.

## Architecture

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client on your Mac
  -> Local iPhone MCP server
  -> XCUITest / WebDriverAgent
  -> USB-connected iPhone
  -> Mobile Safari
```

The bridge preserves the upstream Appium catalog and adds two non-blocking lifecycle tools:

- `appium_prepare_ios_real_device_async`
- `appium_create_session_async`

Both support `start`, `status`, and `cancel`. Safari session requests use a private, persistent FIFO waiting room. Only one preparation or owned session may run across local bridge processes, while up to 20 Safari requests may wait in the managed bridge runtime.

## Requirements

- macOS with Xcode 16 or newer
- Node.js 24 or newer
- a paired, trusted iPhone with Developer Mode enabled
- Safari Web Inspector and Remote Automation enabled
- an Apple Development identity and suitable WDA provisioning profile
- OpenAI Secure MCP Tunnel access with Tunnels Read + Use
- ChatGPT developer-mode app access

Official tunnel documentation: [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## Install

```bash
bash scripts/bootstrap-local.sh
```

Bootstrap uses the committed lockfile, applies the reviewed dependency patches, checks Xcode, and runs the direct MCP contract. It refuses to replace dependencies while its managed runtime is active.

If signing is missing, add your Apple ID under **Xcode -> Settings -> Accounts**, then create the WDA runner profile:

```bash
IOS_DEVICE_UDID=<connected-udid> \
DEVELOPMENT_TEAM=<apple-team-id> \
bash scripts/prepare-ios-signing.sh
```

Device IDs, team IDs, profile UUIDs, signed WDA files, screenshots, and runtime keys must stay outside the repository.

## Connect

Store the runtime key in a user-owned mode-`600` file:

```bash
mkdir -p "$HOME/.config/chatgpt-iphone-bridge"
chmod 700 "$HOME/.config/chatgpt-iphone-bridge"
umask 077
read -rs CONTROL_PLANE_KEY
printf '%s' "$CONTROL_PLANE_KEY" > "$HOME/.config/chatgpt-iphone-bridge/runtime-api-key"
unset CONTROL_PLANE_KEY
chmod 600 "$HOME/.config/chatgpt-iphone-bridge/runtime-api-key"
```

Connect a dedicated tunnel:

```bash
CONTROL_PLANE_TUNNEL_ID=tunnel_... bash scripts/connect-tunnel.sh
```

The default managed alias is `local-iphone-bridge`. Connect refuses to replace a running alias that targets another launcher and rolls back a runtime that it starts but cannot make ready.

Create a ChatGPT developer-mode app named **Local iPhone**, choose **Tunnel**, select this dedicated tunnel, and use **No Auth** for the MCP app. Workspace and tunnel access therefore equal temporary control of the unlocked phone.

## ChatGPT workflow

1. Call `select_device` with `platform=ios` and `iosDeviceType=real`.
2. Call `appium_prepare_ios_real_device_async` with `action=start` and the selected UDID.
3. Poll `action=status` with the returned `operationId`. Pick a recommended profile from the discovery result.
4. Start preparation again with that profile UUID and poll with its `operationId` until `state=ready`. Selecting the same iPhone again preserves this shared ready preparation.
5. Combine the returned `capabilitiesHint` with:

```json
{
  "browserName": "Safari",
  "appium:safariInitialUrl": "https://example.test/"
}
```

6. Call `appium_create_session_async` with `action=start`, the capabilities, and a unique `clientRequestId`. Reuse that client request ID only when retrying the same start call.
7. Keep the returned `operationId` private. Poll `action=status` with it until `state=ready`. A waiting response includes its one-based position, queue depth, reason, heartbeat deadline, and recommended poll interval. Every waiting status call renews the 10-minute heartbeat.
8. Use `action=cancel` with the same operation ID to leave the queue or clean up an active request.
9. Use normal Appium interaction tools with the returned session.
10. Delete the owned session when finished so the next live request can start.

Queued requests survive a managed bridge restart in FIFO order. A restored request must send one fresh status heartbeat before it can start. Work that was already starting or active is marked `interrupted` because Appium session survival cannot be proven.

Waiting requests expire after ten minutes without a status heartbeat and cannot be revived. Active sessions have no automatic expiry.

Before creation, the bridge verifies that the selected iPhone is unlocked. Preinstalled WDA gets a 60-second launch window and one internal retry after a clean launch failure; the same async operation and `clientRequestId` remain in use. Terminal failures distinguish `DEVICE_LOCKED`, `DEVICE_STATE_UNAVAILABLE`, `WDA_LAUNCH_FAILED`, and `LIFECYCLE_TIMEOUT`.

Blocking preparation and creation, remote Appium URLs, session attachment, simulators, Android, native apps, and unprepared WDA paths fail closed.

Privileged tools are disabled by default. Enable only named tools locally:

```bash
APPIUM_BRIDGE_PRIVILEGED_TOOLS=appium_mobile_clipboard,appium_geolocation \
CONTROL_PLANE_TUNNEL_ID=tunnel_... \
bash scripts/connect-tunnel.sh
```

Set `APPIUM_BRIDGE_UNSAFE_FULL_APPIUM=true` only in a fully trusted local environment.

## Operations

```bash
npm test
npm run status
npm run queue:status
npm run runtime:monitor:install
npm run runtime:monitor:status
npm run runtime:repair
npm run doctor
npm run prune
bash scripts/stop.sh
```

- `status` is fast and redacted.
- `queue:status` is local-only and shows the redacted FIFO order and private operation handles without capabilities, URLs, device IDs, or session IDs.
- `runtime:monitor:install` installs an alert-only user LaunchAgent that checks the canonical runtime every 60 seconds. Install it only from the stable checkout path; it never reconnects automatically and can be removed with `npm run runtime:monitor:uninstall`.
- `runtime:monitor:status` checks `process_running`, `healthy`, `ready`, and the exact launcher without changing runtime state.
- `runtime:repair` is the only monitor-related reconnect path. It reuses the canonical alias and stored tunnel ID, validates the mode-`600` runtime key, and refuses another launcher.
- `doctor` checks the toolchain, MCP contract, model-based real-device presence, signing, and managed runtime. A user-defined device name does not affect detection.
- `prune` removes screenshots older than seven days; override with `APPIUM_BRIDGE_RETENTION_DAYS`.
- `stop` is idempotent and refuses to stop an alias that targets another launcher.

## Neutral Safari fixture

The repository includes a small generic page for simulator and physical-device acceptance:

```bash
npm run fixture
```

It binds to loopback by default. To make it reachable from an iPhone on a trusted LAN:

```bash
FIXTURE_HOST=0.0.0.0 npm run fixture
```

Do not expose the fixture beyond the intended test network.

Physical smoke probes the controlled page before consuming an iPhone session. If local VPN or firewall policy blocks inbound LAN HTTP, configure an explicit neutral HTTPS fallback:

```bash
BRIDGE_FIXTURE_URL=http://192.168.1.10:4173/ \
BRIDGE_FIXTURE_FALLBACK_URL=https://example.com/ \
BRIDGE_FIXTURE_FALLBACK_SELECTOR=h1 \
BRIDGE_FIXTURE_FALLBACK_MARKER='Example Domain' \
npm run smoke:physical
```

The smoke output reports `fixture_source=controlled` or `fixture_source=fallback`; it never silently substitutes a page.

## ChatGPT app release gate

`npm run smoke` verifies that the live MCP tool schema contains `clientRequestId`. After any tool name, description, or input-schema change, refresh **Local iPhone** under ChatGPT plugin settings and open a fresh chat. Do not declare the update complete until the managed schema also shows `clientRequestId` and a ChatGPT-native physical Safari run ends with a screenshot, zero sessions, and an empty queue. Add required arguments only through a compatibility window or a versioned tool.

## Extension API

External packages can compose additional Appium plugins without copying the lifecycle implementation:

```js
import { startIphoneBridgeServer } from "chatgpt-iphone-bridge/server";

await startIphoneBridgeServer({
  plugins: [myPlugin],
  serverName: "My Local iPhone Tools",
  policy: { allowTools: [/^(?!prepare_ios_simulator$).*$/] }
});
```

The bridge package version is `0.2.0-beta.1`; consumers should use an exact version.

## Security

This bridge can control a real unlocked phone and signed-in Safari sessions. Read [SECURITY.md](SECURITY.md) before connecting it.

## License

MIT. See [LICENSE](LICENSE).
