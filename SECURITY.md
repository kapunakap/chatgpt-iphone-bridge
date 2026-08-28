# Security

## Trust boundary

The OpenAI Secure MCP Tunnel is the only remote transport. Appium MCP remains a local stdio process and no public Appium listener is created.

Anyone who can invoke the connected ChatGPT app may be able to:

- control the connected iPhone;
- read visible Mobile Safari content;
- interact with signed-in websites;
- install and launch WebDriverAgent during device preparation.

Treat access to the ChatGPT app and workspace as equivalent to temporary physical control of the unlocked phone.

## Secrets

- Keep the tunnel runtime API key outside the repository in a user-owned mode-`600` file.
- Never commit API keys, provisioning profiles, certificates, WDA artifacts, device IDs, logs, screenshots, or recordings.
- Do not paste the runtime key into issue comments, screenshots, or command-line arguments.
- Review `git status`, tracked files, and staged diffs before every commit.

## Web content

Safari pages are untrusted input. A page can contain prompt injection intended to make the AI operate outside the requested task. Keep tool use scoped to the named URL and visible test flow.

## Session cleanup

Delete Appium-owned sessions before stopping the tunnel. Stop the `local-iphone` managed runtime when the bridge is not in use, and disconnect the ChatGPT app if access should be revoked.

## Dependency review

The exact Appium MCP pin brings a large upstream mobile-automation dependency tree. Run `npm audit --omit=dev` before release, review each reachable advisory, and do not use `npm audit fix --force`: npm may replace the requested Appium MCP version with an older incompatible release.

As of 2026-08-28, the pinned production tree reports 15 advisories: 1 low, 1 moderate, and 13 high. They are in Appium MCP or its transitive mobile-automation, signing, WebDriver, and test-tooling dependencies. No compatible automatic remediation is currently available while preserving `appium-mcp@1.92.7`; review the current upstream report before use.

## Reporting

Do not include runtime keys, signing material, device identifiers, or authenticated page content in public reports.
