# ChatGPT iPhone Bridge
<img width="1672" height="941" alt="ChatGPT Image Aug 30, 2026, 03_29_42 AM" src="https://github.com/user-attachments/assets/f3e87553-787e-4692-88e1-790056cd4e5f" />

Control Mobile Safari on one USB-connected iPhone from ChatGPT through OpenAI Secure MCP Tunnel and Appium MCP. An opt-in experimental mode can instead control a dedicated Bridge Browser app on an iPhone over cellular.

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

The experimental cellular path is separate:

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> this bridge on your online Mac
  -> end-to-end encrypted Cloudflare relay
  -> Bridge Browser app over cellular
  -> WKWebView
```

The cellular app is not Safari and does not expose Appium compatibility tools.

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

Cellular mode additionally needs a Cloudflare Workers account, iOS 17 or newer, and one initial USB install of the Bridge Browser app from Xcode.

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
- `runtime:monitor:status` checks `process_running`, `healthy`, `ready`, and either owned USB-only or cellular launcher identity without changing runtime state.
- `runtime:repair` is the only monitor-related reconnect path. It reuses the canonical alias and stored tunnel ID, validates the mode-`600` runtime key, and refuses another launcher. Repairing cellular mode requires the same `IPHONE_BRIDGE_CELLULAR_*` environment used to connect it.
- `doctor` checks the toolchain, MCP contract, model-based real-device presence, signing, and managed runtime. A user-defined device name does not affect detection.
- `prune` removes screenshots older than seven days; override with `APPIUM_BRIDGE_RETENTION_DAYS`.
- `stop` is idempotent and refuses to stop an alias that targets another launcher.

## Experimental cellular Bridge Browser

This zero-cost prototype lets the target iPhone leave the Mac and use cellular data. The Mac must stay powered on and connected to the existing Secure MCP Tunnel. The user must manually open Bridge Browser, approve the requested HTTPS origins, and keep the app in the foreground.

Cloudflare Durable Objects are available on the Workers Free plan. If the free quota is exhausted, the relay fails closed. No public port is opened on the Mac.

### 1. Deploy the relay

```bash
npm ci --prefix relay
npm exec --prefix relay -- wrangler login
npm run cellular:deploy
```

Save the deployed `https://...workers.dev` URL. The relay uses a SQLite-backed Durable Object and hibernating WebSockets. Application logging is disabled.

### 2. Install the free iPhone app

Connect the iPhone once, select a unique bundle ID, and use the Personal Team shown in Xcode:

```bash
IOS_DEVICE_UDID=<connected-udid> \
DEVELOPMENT_TEAM=<personal-team-id> \
BRIDGE_BROWSER_BUNDLE_ID=com.example.myiphonebridge \
npm run cellular:ios:install
```

A free Personal Team provisioning profile expires after seven days. Rerun the install command every week. This prototype does not use TestFlight or push notifications.

### 3. Pair the phone

```bash
export IPHONE_BRIDGE_CELLULAR_RELAY_URL=https://your-relay.workers.dev
export IPHONE_BRIDGE_CELLULAR_IDENTITY_FILE="$HOME/.config/chatgpt-iphone-bridge/cellular-host.json"
npm run cellular:pair
```

Scan the displayed QR in Bridge Browser, or paste the printed pairing payload. It expires after five minutes. The host identity is written outside the repository with mode `600`.

If the terminal QR is not visible, set `IPHONE_BRIDGE_PAIRING_QR_FILE` to an absolute PNG path before running `cellular:pair`. The QR file is written mode `600`; delete it after pairing.

### 4. Enable cellular tools

Pass the opt-in configuration when connecting the existing tunnel:

```bash
IPHONE_BRIDGE_CELLULAR_ENABLED=true \
IPHONE_BRIDGE_CELLULAR_RELAY_URL=https://your-relay.workers.dev \
IPHONE_BRIDGE_CELLULAR_IDENTITY_FILE="$HOME/.config/chatgpt-iphone-bridge/cellular-host.json" \
CONTROL_PLANE_TUNNEL_ID=tunnel_... \
bash scripts/connect-tunnel.sh
```

The cellular and USB-only modes use distinct managed launcher identities. If the USB-only runtime is already active, stop it with `bash scripts/stop.sh` before connecting cellular mode. The bridge refuses to silently reuse a runtime started in the other mode.

Disabled mode still exposes exactly the original 33 Appium tools. Enabled mode adds seven separate tools:

- `iphone_browser_device_status`
- `iphone_browser_session`
- `iphone_browser_navigate`
- `iphone_browser_find`
- `iphone_browser_element`
- `iphone_browser_snapshot`
- `iphone_browser_screenshot`

Start `iphone_browser_session` with an HTTPS `initialUrl` and explicit `allowedOrigins`. Poll while the phone is closed. Open Bridge Browser, review the origins, tap **Approve**, and keep the app foreground. Stop the session when finished.

Only approved HTTPS top-level origins are allowed. Downloads, custom URL schemes, file URLs, arbitrary remote JavaScript, media permissions, native apps, Safari, and unattended background control are not supported.

### Example: mobile gameplay testing

Bridge Browser can test a browser-based mobile game through the same touch-oriented UI that a player sees on the iPhone. ChatGPT can locate DOM controls, tap a context button, press and hold a throttle, drag a joystick within normalized element coordinates, read HUD text, and capture screenshot checkpoints. The iPhone may use Wi-Fi or cellular, but Bridge Browser must remain open in the foreground.

For example, the following prompt tests the public GTA Labin build without USB or Appium:

```text
Use only the Local iPhone iphone_browser_* tools. Do not use Appium, Safari,
select_device, or arbitrary JavaScript.

1. Call iphone_browser_device_status and require secureReady=true.
2. Start iphone_browser_session for:
   initialUrl: https://kapunakap.github.io/gta-labin/
   allowedOrigins: ["https://kapunakap.github.io"]
3. Keep polling the same operation. Ask me to open Bridge Browser and tap
   Approve when the native approval card appears. Do not cancel it.
4. When ready, take a snapshot and confirm LABIN 52220 is visible.
5. Find CSS [data-touch-action=context], tap it, refind it, and verify its
   text changes from ENTER to EXIT.
6. Find CSS [data-touch-action=gas] and press it for 1500 ms at x=0.5,y=0.5.
7. Find CSS [data-touch-stick=move] and drag from x=0.5,y=0.5 to
   endX=0.8,endY=0.5 for 700 ms.
8. Capture a snapshot and screenshot. Report the visible speed/distance and
   whether it changed from the previous checkpoint.
9. Stop the exact session and require state=closed and cleanupPending=false.
```

`iphone_browser_element` supports `tap`, `press`, and `drag` without adding another MCP tool. A press is bounded to 10 seconds. Drag coordinates are relative to the found element: `0,0` is its top-left and `1,1` is its bottom-right. Refind an element after the page replaces it or navigation changes the document.

This workflow is suitable for smoke tests, HUD assertions, menus, virtual buttons, and short movement checkpoints. It does not turn Bridge Browser into native-app automation. Games that require hardware buttons, native APIs, trusted OS gestures, pointer lock, or controls that are not exposed through the page may still need the separate USB/Appium physical QA harness.

### Cellular operations

```bash
npm run cellular:status
npm run cellular:doctor
npm run cellular:revoke
npm run cellular:ios:check
```

`status` and `doctor` are redacted. `revoke` invalidates both relay credentials and removes the local host credential. Pair again before re-enabling cellular mode.

Local tests and an unsigned iOS build do not prove cellular acceptance. Before release, verify the full flow through hosted ChatGPT with the iPhone unplugged, Wi-Fi disabled, and no active Appium session.

### Local physical Bridge Browser QA

The local-only harness launches only `com.kapunakap.chatgptiphonebridge.BridgeBrowser`. It refuses Safari and other apps, uses one persistent local Appium MCP connection, and never uses the OpenAI tunnel. Its unsafe Appium policy bypass exists only in that child process.

Stop the managed tunnel first, keep the paired iPhone unlocked, then run:

```bash
IPHONE_BRIDGE_CELLULAR_ENABLED=true \
IPHONE_BRIDGE_CELLULAR_RELAY_URL=https://your-relay.workers.dev \
IPHONE_BRIDGE_CELLULAR_IDENTITY_FILE="$HOME/.config/chatgpt-iphone-bridge/cellular-host.json" \
npm run qa:bridge-browser:physical
```

Use `-- --diagnose-only` to capture the native connection screen and require `hostOnline`, `deviceOnline`, and `secureReady` without starting GTA Labin. Full runs retain private screenshots and route checkpoints under ignored `artifacts/bridge-browser-physical-qa/`. Success requires WebGPU, CREATE, ENTER, sustained physical GAS/BRAKE/steering actions, route completion, background close/reconnect, zero Appium sessions, and no remaining lease directory. Any partial run is a failure and does not count as Safari acceptance.

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

External packages can enable the paired cellular browser with `cellular: { enabled: true, relayUrl, identityPath }`; it remains disabled when this option and the matching environment flag are absent.

The bridge package version is `0.2.0-beta.3`; consumers should use an exact version.

## Security

This bridge can control a real unlocked phone and signed-in Safari sessions. Read [SECURITY.md](SECURITY.md) before connecting it.

## License

MIT. See [LICENSE](LICENSE).
