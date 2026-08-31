# Bridge Browser for iPhone

Bridge Browser is an iOS 17+ SwiftUI app with a persistent WKWebView. It provides approved, foreground-only web automation over the encrypted cellular relay. It is not Safari and cannot control native apps.

For a free Personal Team install:

```bash
IOS_DEVICE_UDID=<connected-udid> \
DEVELOPMENT_TEAM=<personal-team-id> \
BRIDGE_BROWSER_BUNDLE_ID=com.example.myiphonebridge \
npm run cellular:ios:install
```

The free profile expires after seven days. The app deliberately has no push-notification or background-mode entitlement. Open it manually, approve the listed HTTPS origins, and keep it foreground during the session.

Run `npm run cellular:ios:check` for an unsigned simulator build plus Swift/Node crypto interoperability checks.
