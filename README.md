# ChatGPT iPhone Bridge

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

Both support `start`, `status`, and `cancel`. Only one preparation or owned session may run across local bridge processes.

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
3. Poll `action=status`. Pick a recommended profile from the discovery result.
4. Start preparation again with that profile UUID and poll until `state=ready`.
5. Combine the returned `capabilitiesHint` with:

```json
{
  "browserName": "Safari",
  "appium:safariInitialUrl": "https://example.test/"
}
```

6. Call `appium_create_session_async` with `action=start`, then poll until `state=ready`.
7. Use normal Appium interaction tools with the returned session.
8. Delete the owned session when finished.

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
npm run doctor
npm run prune
bash scripts/stop.sh
```

- `status` is fast and redacted.
- `doctor` checks the toolchain, MCP contract, device, signing, and managed runtime.
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

### Cellular operations

```bash
npm run cellular:status
npm run cellular:doctor
npm run cellular:revoke
npm run cellular:ios:check
```

`status` and `doctor` are redacted. `revoke` invalidates both relay credentials and removes the local host credential. Pair again before re-enabling cellular mode.

Local tests and an unsigned iOS build do not prove cellular acceptance. Before release, verify the full flow through hosted ChatGPT with the iPhone unplugged, Wi-Fi disabled, and no active Appium session.

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

If local VPN or firewall policy blocks inbound LAN HTTP, the physical smoke can use another neutral HTTPS page by setting `BRIDGE_FIXTURE_URL`, `BRIDGE_FIXTURE_SELECTOR`, and `BRIDGE_FIXTURE_MARKER` explicitly.

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

The bridge package version is `0.2.0-beta.1`; consumers should use an exact version.

## Security

This bridge can control a real unlocked phone and signed-in Safari sessions. Read [SECURITY.md](SECURITY.md) before connecting it.

## License

MIT. See [LICENSE](LICENSE).
