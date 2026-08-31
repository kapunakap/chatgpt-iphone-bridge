# Security

## Trust boundary

OpenAI Secure MCP Tunnel is the only remote transport. Appium MCP remains a local stdio process and no public Appium listener is created.

Anyone who can invoke the connected ChatGPT app may be able to control the unlocked phone and interact with signed-in Safari pages. Treat workspace and app access as temporary physical access to the device.

Stop the managed runtime when it is not being used.

## Cellular prototype trust boundary

Cellular mode controls a dedicated WKWebView app, not Safari. It is disabled unless `IPHONE_BRIDGE_CELLULAR_ENABLED=true` is set on the Mac bridge.

The Cloudflare relay accepts one host socket and one device socket per opaque device ID. It stores only the device alias, timestamps, public signing keys, hashed bearer credentials, revocation state, and a five-minute pairing-secret hash. Raw host and device credentials are returned once over TLS and are never stored. Browser commands, URLs, text, cookies, screenshots, decrypted responses, and session identifiers are not persisted or application-logged by the relay.

Command payloads use an authenticated ephemeral P-256 handshake, HKDF-SHA256, and AES-GCM between the paired Mac and iPhone. The relay can still observe IP addresses, connection timing, message sizes, and normal Cloudflare account/platform metadata.

The pairing QR or manual payload grants one-time pairing authority for five minutes. Do not post it, include it in logs, or send it through an untrusted channel. Revoke lost or unexpected pairings with `npm run cellular:revoke`.

Every remote session requires the user to open the app and approve the requested HTTPS top-level origins. Backgrounding or locking the iPhone ends the session. A foreground network interruption has a 30-second reconnect grace. This is not unattended automation.

Bridge Browser stores normal WKWebView cookies and website data on the iPhone. Session end keeps them for signed-in testing. Use **Clear browsing data** on the phone when persistence is not wanted. Downloads, file URLs, custom schemes, media capture, arbitrary remote JavaScript, and top-level navigation outside approved origins are blocked.

Free Personal Team builds expire after seven days. Reinstalling may require pairing again. No production or public-release claim is valid until the full hosted ChatGPT flow passes with USB disconnected and Wi-Fi disabled.

## Runtime monitoring

The optional user LaunchAgent is alert-only. It probes runtime health every 60 seconds and never starts or reconnects the tunnel. `npm run runtime:repair` remains an explicit local operator action and refuses a canonical alias configured for another launcher.

## Enforced defaults

Unless the local operator explicitly enables unsafe full Appium behavior, the bridge:

- selects only real iOS devices;
- requires non-blocking preparation and Safari session creation;
- rejects remote Appium URLs and attached sessions;
- rejects Android, simulators, and native-app capabilities;
- accepts only the selected device and successfully prepared WDA path;
- disables Appium relaxed security;
- blocks file, clipboard, application, permissions, geolocation, settings, and device-control tools unless named locally;
- binds legacy WDA port forwarding to `127.0.0.1`;
- keeps the cellular browser and its seven tools disabled by default;
- permits only one preparation or owned session across local bridge processes.

These controls reduce accidental exposure. They do not provide per-user authorization inside one ChatGPT workspace. Queue operation IDs are unguessable bearer handles: keep each returned handle inside its requesting ChatGPT task and do not publish it.

## Secrets and artifacts

- Keep runtime API keys outside the repository in a user-owned mode-`600` file.
- Keep artifact directories mode `700` and files mode `600`.
- The persistent waiting-room file is stored under the private runtime artifact directory with mode `600`. It contains validated queued capabilities so requests can resume after restart; the MCP status payload and local queue-status command never print those capabilities.
- The runtime monitor stores only redacted health booleans, failure names, and the expected local launcher path in a mode-`600` state file. It stores no keys, device IDs, capabilities, URLs, or session IDs.
- Never commit keys, provisioning profiles, certificates, signed WDA packages, device IDs, logs, screenshots, or recordings.
- Do not put secrets or device identifiers in command-line arguments.
- Review tracked and staged files before every commit.

The launcher uses a private umask. `npm run prune` removes old screenshots only from the configured bridge screenshot directory.

## Web content

Safari pages are untrusted input. A page can contain prompt injection intended to make the AI operate outside the requested test. Keep the tool request scoped to the named URL and visible flow.

The included fixture is for controlled acceptance only. Its LAN binding is opt-in.

## Lifecycle

- Use the async lifecycle tools for long preparation and creation calls.
- Session creation fails before Appium startup when the selected device reports a locked state. A clean preinstalled-WDA launch failure may retry once inside the same private async operation.
- Cancelled or timed-out creation deletes any late-created owned session.
- Waiting Safari requests are FIFO, require a status heartbeat within ten minutes, and may be cancelled with their private operation ID.
- On restart, queued requests require a fresh confirmation heartbeat; starting or active requests are marked interrupted rather than assumed safe.
- A cleanup failure retains the cross-process lease and blocks new work.
- Disconnect and stop attempt owned-session cleanup before releasing the lease.
- `stop.sh` refuses to stop a managed alias that targets a different launcher.

## Dependency review

The exact Appium MCP dependency brings a large mobile-automation and signing tree. The repository applies reviewed patches for:

- complete MCP result preservation and hook cleanup;
- disabled relaxed security and redacted capability logging;
- loopback-only legacy WDA forwarding.

As of 2026-08-30, `npm audit --omit=dev` reports 15 transitive advisories: 1 low, 1 moderate, and 13 high. The exact reviewed package set and review deadline are tracked in `security/audit-baseline.json`; CI fails when the set changes or the review expires.

Do not run `npm audit fix --force`: npm currently proposes an incompatible Appium MCP downgrade. A beta release must keep the advisory review current and must not add a critical advisory.

## Reporting

Do not include runtime keys, signing material, device identifiers, session IDs, authenticated page content, screenshots, or raw diagnostic logs in public reports.
