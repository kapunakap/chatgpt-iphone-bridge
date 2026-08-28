# ChatGPT iPhone Bridge

Control Mobile Safari on a real USB-connected iPhone from ChatGPT through OpenAI Secure MCP Tunnel and [Appium MCP](https://github.com/appium/appium-mcp).

This is an unofficial, experimental local bridge. It opens no public inbound port and does not expose Appium directly to the internet.

## Architecture

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> tunnel-client on your Mac
  -> Appium MCP over stdio
  -> XCUITest / WebDriverAgent
  -> USB-connected iPhone
  -> Mobile Safari
```

## Requirements

- macOS with Xcode 16 or newer
- Node.js 22 or newer
- a paired iPhone with Developer Mode enabled
- **Settings -> Apps -> Safari -> Advanced -> Web Inspector** enabled on the iPhone
- **Settings -> Apps -> Safari -> Advanced -> Remote Automation** enabled on the iPhone
- an Apple ID/Personal Team in Xcode
- a valid development profile whose bundle ID is `*` or ends in `.xctrunner`
- an OpenAI Secure MCP Tunnel associated with the target Platform organization and ChatGPT workspace
- a runtime API key with Tunnels Read + Use
- ChatGPT developer-mode app access

Official tunnel documentation: [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## 1. Bootstrap

```bash
bash scripts/bootstrap-local.sh
```

The repository pins `appium-mcp` to `1.92.7`. The bootstrap validates the toolchain, installs the exact package, runs a direct MCP handshake, lists Xcode devices, and reports signing readiness.

If signing is missing, add the Apple ID in **Xcode -> Settings -> Accounts** and select the Personal Team. Then generate the exact WDA runner profile from the bundled project:

```bash
IOS_DEVICE_UDID=<connected UDID> \
DEVELOPMENT_TEAM=<Apple team ID> \
bash scripts/prepare-ios-signing.sh
```

The default runner profile bundle ID is `com.kapunakap.chatgptiphonebridge.WebDriverAgentRunner.xctrunner`. Override the base with `WDA_BUNDLE_ID_BASE` when needed; omit the `.xctrunner` suffix because Xcode adds it to the runner.

Then rerun:

```bash
bash scripts/ios-signing-status.sh
```

Before the first WDA launch, trust the Developer App on the iPhone under **Settings -> General -> VPN & Device Management**.

If Safari session creation reports that the remote debugger did not respond, recheck both **Web Inspector** and **Remote Automation**, dismiss any Safari modal or first-run screen, and keep the phone unlocked. `about:blank` must work before testing an application URL.

## 2. Provision a dedicated tunnel

Create a tunnel in OpenAI Platform and associate it with the ChatGPT workspace that will use it. Store its runtime key outside this repository:

```bash
mkdir -p "$HOME/.config/chatgpt-iphone-bridge"
chmod 700 "$HOME/.config/chatgpt-iphone-bridge"
umask 077
cat > "$HOME/.config/chatgpt-iphone-bridge/runtime-api-key"
# paste the runtime key, then press Ctrl-D
chmod 600 "$HOME/.config/chatgpt-iphone-bridge/runtime-api-key"
```

Never pass the raw key in a command-line argument or commit it.

## 3. Connect

```bash
CONTROL_PLANE_TUNNEL_ID=tunnel_... bash scripts/connect-tunnel.sh
```

Defaults:

- tunnel alias: `local-iphone`
- runtime key: `~/.config/chatgpt-iphone-bridge/runtime-api-key`
- screenshots: `~/Library/Application Support/chatgpt-iphone-bridge/screenshots`

## 4. Create the ChatGPT app

In ChatGPT developer-mode Plugins:

1. Create an app named **Local iPhone**.
2. Choose **Tunnel**.
3. Select the dedicated iPhone tunnel.
4. Choose **No Auth** for the MCP app itself.

Local health is not hosted acceptance. Confirm that ChatGPT can discover and call the Appium tools before trusting the bridge.

## 5. Prepare the real device

Ask ChatGPT to use Local iPhone in this order:

1. Call `select_device` with `platform=ios` and `iosDeviceType=real`.
2. Call `appium_prepare_ios_real_device` without a profile UUID.
3. Choose a returned profile marked `recommendedForWda=true`.
4. Call the preparation tool again with that profile UUID.
5. Create a session with `platform=ios` and a JSON capabilities string containing:

```json
{
  "browserName": "Safari",
  "appium:usePreinstalledWDA": true,
  "appium:prebuiltWDAPath": "<returned path>",
  "appium:wdaLaunchTimeout": 30000,
  "appium:initialDeeplinkUrl": "<exact test URL>"
}
```

Use the exact returned values. After successful real-device selection or preparation, the bridge injects the runtime-only iPhone UDID when a real-WDA session omits `appium:udid`. An explicit UDID is preserved. Do not save device IDs, team IDs, profile UUIDs, or WDA paths in this repository.

## Operations

```bash
npm test
bash scripts/status.sh
bash scripts/stop.sh
```

For a local one-shot MCP tool call, pass arguments on stdin so device-specific values do not appear in process arguments:

```bash
printf '%s\n' '{"platform":"ios","iosDeviceType":"real"}' \
  | npm run tool -- select_device
```

Delete the active Appium session before stopping the tunnel when possible.

## Session safety

This bridge composes the default server through the supported `appium-mcp/core` plugin API without adding or replacing Appium tools. It keeps the upstream 31-tool interface and adds only runtime safeguards:

- a real-device selection remains available for later WDA session creation;
- explicit iPhone UDIDs are preserved;
- simulator and non-iOS session capabilities are unchanged;
- concurrent or duplicate Appium-owned session creation fails closed.

Device identifiers remain in memory only and are never written to the repository.

## Security

This bridge can control a real unlocked phone and any signed-in Safari sessions. Read [SECURITY.md](SECURITY.md) before connecting it.

## License

MIT. See [LICENSE](LICENSE).
