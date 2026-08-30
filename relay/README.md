# Cellular relay

This Cloudflare Worker routes opaque, end-to-end encrypted frames between one Mac bridge and one Bridge Browser app.

It uses SQLite-backed Durable Objects and the WebSocket Hibernation API so the prototype can run inside Cloudflare's free limits. The Worker does not decrypt or application-log browser traffic.

```bash
npm ci
npm test
npm run check
npx wrangler deploy --dry-run
npx wrangler deploy
```

For a local end-to-end check, run `npx wrangler dev --local --port 8799` here, then run `npm run smoke:relay -- http://127.0.0.1:8799` from the repository root.

The public API is versioned under `/v1`. Pairing expires after five minutes. Each role receives a different bearer token; only its SHA-256 hash is stored. Revocation closes both sockets and removes the stored credential hashes and public keys.
