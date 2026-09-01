# ChatGPT iPhone Bridge

Control Mobile Safari on a USB-connected pool of iPhones and iPads from ChatGPT through OpenAI Secure MCP Tunnel and Appium MCP.

This is an unofficial beta candidate. It opens no public inbound port and does not expose Appium directly to the internet.

## Architecture

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client on your Mac
  -> Local iOS MCP server
  -> XCUITest / WebDriverAgent
  -> USB-connected iPhone/iPad pool
  -> Mobile Safari
```

The bridge preserves the upstream Appium catalog and adds two non-blocking lifecycle tools:

- `appium_prepare_ios_real_device_async`
- `appium_create_session_async`

Both support `start`, `status`, and `cancel`. Session creation and owned sessions may run independently on different UDIDs. WDA preparation is serialized because its signing cache is shared. A per-device lease prevents two local bridge processes from controlling the same device.

## Requirements

- macOS with Xcode 16 or newer
- Node.js 24 or newer
- one or more paired, trusted iPhones or iPads with Developer Mode enabled
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

1. Call `select_device` with `platform=ios` and `iosDeviceType=real` to list the pool.
2. Call `select_device` again with `deviceUdid` for every device you intend to use.
3. Call `appium_prepare_ios_real_device_async` with `action=start` and one selected UDID.
4. Poll with its `operationId`. Pick a recommended profile from the discovery result.
5. Start preparation again with that UDID and profile UUID, then poll until `state=ready`.
6. Combine the returned `capabilitiesHint` with:

```json
{
  "browserName": "Safari",
  "appium:safariInitialUrl": "https://example.test/"
}
```

7. Call `appium_create_session_async` with `action=start`, the target `udid`, and `capabilities`, then poll by `operationId` until `state=ready`.
8. Repeat steps 3-7 for other selected devices. Prepare devices one at a time; session creation and active sessions may overlap across devices.
9. Use normal Appium interaction tools with the returned `sessionId`. Always pass it when the pool has multiple sessions.
10. Delete each owned session when finished.

The old single-device flow remains valid: after selecting exactly one device, `udid` may be omitted from session creation and status/cancel may omit `operationId` while only one lifecycle operation exists.

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

The bridge package version is `0.2.0-beta.1`; consumers should use an exact version.

## Security

This bridge can control a real unlocked phone and signed-in Safari sessions. Read [SECURITY.md](SECURITY.md) before connecting it.

## License

MIT. See [LICENSE](LICENSE).
