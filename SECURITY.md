# Security

## Trust boundary

OpenAI Secure MCP Tunnel is the only remote transport. Appium MCP remains a local stdio process and no public Appium listener is created.

Anyone who can invoke the connected ChatGPT app may be able to control the unlocked phone and interact with signed-in Safari pages. Treat workspace and app access as temporary physical access to the device.

Stop the managed runtime when it is not being used.

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
- permits only one preparation or owned session across local bridge processes.

These controls reduce accidental exposure. They do not provide per-user authorization inside one ChatGPT workspace.

## Secrets and artifacts

- Keep runtime API keys outside the repository in a user-owned mode-`600` file.
- Keep artifact directories mode `700` and files mode `600`.
- Never commit keys, provisioning profiles, certificates, signed WDA packages, device IDs, logs, screenshots, or recordings.
- Do not put secrets or device identifiers in command-line arguments.
- Review tracked and staged files before every commit.

The launcher uses a private umask. `npm run prune` removes old screenshots only from the configured bridge screenshot directory.

## Web content

Safari pages are untrusted input. A page can contain prompt injection intended to make the AI operate outside the requested test. Keep the tool request scoped to the named URL and visible flow.

The included fixture is for controlled acceptance only. Its LAN binding is opt-in.

## Lifecycle

- Use the async lifecycle tools for long preparation and creation calls.
- Cancelled or timed-out creation deletes any late-created owned session.
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
