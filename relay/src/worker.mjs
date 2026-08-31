import {
  MAX_CONTROL_BODY_BYTES,
  MAX_RELAY_MESSAGE_BYTES,
  PAIRING_RATE_LIMIT,
  PAIRING_RATE_WINDOW_MS,
  PAIRING_TTL_MS,
  RELAY_PROTOCOL_VERSION,
  RelayHttpError,
  isUuid,
  json,
  parseBearer,
  publicError,
  randomToken,
  readJson,
  sha256,
  validateAlias,
  validatePublicKey,
} from "./core.mjs";

function deviceStub(env, deviceId) {
  return env.DEVICES.get(env.DEVICES.idFromName(deviceId));
}

function internalRequest(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Relay-Internal", "1");
  return new Request(url, { ...init, headers });
}

function requireInternal(request) {
  if (request.headers.get("X-Relay-Internal") !== "1") throw new Error("internal relay route only");
}

export function prepareRoleConnection(ctx, role, replace) {
  const existing = ctx.getWebSockets(role);
  if (existing.length === 0) return null;
  if (!replace) return publicError(new Error(`${role} is already connected`), 409, "ROLE_CONNECTED");
  for (const socket of existing) socket.close(1012, "replaced by authenticated reconnect");
  return null;
}

async function rateLimitPairing(request, env) {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const id = env.PAIR_RATES.idFromName(await sha256(address));
  const response = await env.PAIR_RATES.get(id).fetch(internalRequest("https://relay.invalid/check", { method: "POST" }));
  if (!response.ok) return response;
  return null;
}

async function routePairStart(request, env) {
  const limited = await rateLimitPairing(request, env);
  if (limited) return limited;
  const body = await readJson(request);
  const hostPublicKey = validatePublicKey(body.hostPublicKey, "host public key");
  const alias = validateAlias(body.alias);
  const deviceId = crypto.randomUUID();
  const secret = randomToken(24);
  const hostToken = randomToken();
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  const response = await deviceStub(env, deviceId).fetch(
    internalRequest("https://relay.invalid/pair/start", {
      method: "POST",
      body: JSON.stringify({ deviceId, secret, hostTokenHash: await sha256(hostToken), expiresAt, hostPublicKey, alias }),
    }),
  );
  if (!response.ok) return response;
  return json({ version: RELAY_PROTOCOL_VERSION, deviceId, secret, hostToken, expiresAt, alias }, 201);
}

async function routeDevice(request, env, deviceId, action) {
  if (!isUuid(deviceId)) return publicError(new Error("invalid device ID"), 404, "NOT_FOUND");
  const headers = new Headers(request.headers);
  headers.set("X-Relay-Internal", "1");
  const url = new URL(request.url);
  url.hostname = "relay.invalid";
  url.protocol = "https:";
  url.pathname = `/device/${action}`;
  let body;
  if (!new Set(["GET", "HEAD"]).has(request.method)) {
    const advertisedLength = Number(request.headers.get("Content-Length") ?? "0");
    if (Number.isFinite(advertisedLength) && advertisedLength > MAX_CONTROL_BODY_BYTES) {
      return publicError(new Error("request body is too large"), 413, "BODY_TOO_LARGE");
    }
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_CONTROL_BODY_BYTES) return publicError(new Error("request body is too large"), 413, "BODY_TOO_LARGE");
  }
  return await deviceStub(env, deviceId).fetch(new Request(url, { method: request.method, headers, body }));
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ status: "ok", version: RELAY_PROTOCOL_VERSION });
      }
      if (request.method === "POST" && url.pathname === "/v1/pair/start") return await routePairStart(request, env);
      const pairMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/pair\/(complete|status)$/);
      if (pairMatch && request.method === "POST") return await routeDevice(request, env, pairMatch[1], `pair/${pairMatch[2]}`);
      const deviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/(connect|status|revoke)$/);
      if (deviceMatch) {
        const expectedMethod = deviceMatch[2] === "status" ? "GET" : "POST";
        if (deviceMatch[2] === "connect" && request.method === "GET") {
          return await routeDevice(request, env, deviceMatch[1], "connect");
        }
        if (request.method === expectedMethod) return await routeDevice(request, env, deviceMatch[1], deviceMatch[2]);
      }
      return publicError(new Error("route not found"), 404, "NOT_FOUND");
    } catch (error) {
      return publicError(error);
    }
  },
};

export class DeviceRelay {
  constructor(ctx) {
    this.ctx = ctx;
    this.storage = ctx.storage;
  }

  async fetch(request) {
    try {
      requireInternal(request);
      const url = new URL(request.url);
      if (url.pathname === "/pair/start" && request.method === "POST") return await this.pairStart(request);
      if (url.pathname === "/device/pair/complete" && request.method === "POST") return await this.pairComplete(request);
      if (url.pathname === "/device/pair/status" && request.method === "POST") return await this.pairStatus(request);
      if (url.pathname === "/device/status" && request.method === "GET") return await this.status(request);
      if (url.pathname === "/device/revoke" && request.method === "POST") return await this.revoke(request);
      if (url.pathname === "/device/connect" && request.method === "GET") return await this.connect(request);
      return publicError(new Error("route not found"), 404, "NOT_FOUND");
    } catch (error) {
      return publicError(error);
    }
  }

  async pairStart(request) {
    if (await this.storage.get("pairing")) return publicError(new Error("device ID already exists"), 409, "ALREADY_EXISTS");
    const body = await readJson(request);
    if (!isUuid(body.deviceId) || !Number.isSafeInteger(body.expiresAt)) throw new Error("invalid pairing metadata");
    if (typeof body.hostTokenHash !== "string" || !/^[a-f0-9]{64}$/.test(body.hostTokenHash)) {
      throw new Error("invalid host credential hash");
    }
    const pairing = {
      version: RELAY_PROTOCOL_VERSION,
      deviceId: body.deviceId,
      alias: validateAlias(body.alias),
      hostPublicKey: validatePublicKey(body.hostPublicKey, "host public key"),
      secretHash: await sha256(body.secret),
      hostTokenHash: body.hostTokenHash,
      expiresAt: body.expiresAt,
      paired: false,
      revoked: false,
      createdAt: Date.now(),
    };
    await this.storage.put("pairing", pairing);
    await this.storage.setAlarm(body.expiresAt);
    return json({ created: true }, 201);
  }

  async pairComplete(request) {
    const pairing = await this.requirePairing();
    if (pairing.revoked) return publicError(new Error("pairing was revoked"), 410, "REVOKED");
    if (pairing.paired) return publicError(new Error("device is already paired"), 409, "ALREADY_PAIRED");
    if (pairing.expiresAt < Date.now()) {
      await this.storage.deleteAll();
      return publicError(new Error("pairing request expired"), 410, "PAIRING_EXPIRED");
    }
    const body = await readJson(request);
    if ((await sha256(body.secret)) !== pairing.secretHash) return publicError(new Error("pairing secret is invalid"), 401, "UNAUTHORIZED");
    const devicePublicKey = validatePublicKey(body.devicePublicKey, "device public key");
    const deviceToken = randomToken();
    const completed = {
      ...pairing,
      paired: true,
      pairedAt: Date.now(),
      collectionExpiresAt: Date.now() + PAIRING_TTL_MS,
      devicePublicKey,
      deviceTokenHash: await sha256(deviceToken),
    };
    await this.storage.put("pairing", completed);
    await this.storage.setAlarm(completed.collectionExpiresAt);
    return json({
      version: RELAY_PROTOCOL_VERSION,
      deviceId: pairing.deviceId,
      alias: pairing.alias,
      authToken: deviceToken,
      peerSigningPublicKey: pairing.hostPublicKey,
    });
  }

  async pairStatus(request) {
    const pairing = await this.requirePairing();
    const body = await readJson(request);
    if (pairing.expiresAt < Date.now() && !pairing.paired) {
      await this.storage.deleteAll();
      return publicError(new Error("pairing request expired"), 410, "PAIRING_EXPIRED");
    }
    if ((await sha256(body.secret)) !== pairing.secretHash) return publicError(new Error("pairing secret is invalid"), 401, "UNAUTHORIZED");
    if (!pairing.paired) return json({ state: "pending", expiresAt: pairing.expiresAt });
    const response = {
      state: "paired",
      version: RELAY_PROTOCOL_VERSION,
      deviceId: pairing.deviceId,
      alias: pairing.alias,
      peerSigningPublicKey: pairing.devicePublicKey,
    };
    delete pairing.secretHash;
    delete pairing.collectionExpiresAt;
    await this.storage.put("pairing", pairing);
    await this.storage.deleteAlarm();
    return json(response);
  }

  async authorize(request, role) {
    const pairing = await this.requirePairing();
    if (!pairing.paired || pairing.revoked) throw new RelayHttpError("device is not paired", 410, "NOT_PAIRED");
    let token;
    try {
      token = parseBearer(request);
    } catch {
      throw new RelayHttpError("relay credential is missing or invalid", 401, "UNAUTHORIZED");
    }
    const tokenHash = await sha256(token);
    const expected = role === "host" ? pairing.hostTokenHash : pairing.deviceTokenHash;
    if (!expected || tokenHash !== expected) throw new RelayHttpError("relay credential is invalid", 401, "UNAUTHORIZED");
    return pairing;
  }

  async status(request) {
    const role = request.headers.get("X-Bridge-Role") === "device" ? "device" : "host";
    const pairing = await this.authorize(request, role);
    return json({
      paired: pairing.paired,
      revoked: pairing.revoked,
      hostOnline: this.ctx.getWebSockets("host").length === 1,
      deviceOnline: this.ctx.getWebSockets("device").length === 1,
    });
  }

  async revoke(request) {
    const pairing = await this.authorize(request, "host");
    pairing.revoked = true;
    pairing.revokedAt = Date.now();
    delete pairing.hostTokenHash;
    delete pairing.deviceTokenHash;
    delete pairing.hostPublicKey;
    delete pairing.devicePublicKey;
    await this.storage.put("pairing", pairing);
    for (const socket of this.ctx.getWebSockets()) socket.close(1008, "pairing revoked");
    return json({ revoked: true });
  }

  async connect(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return publicError(new Error("WebSocket upgrade required"), 426, "UPGRADE_REQUIRED");
    }
    const role = new URL(request.url).searchParams.get("role");
    if (!new Set(["host", "device"]).has(role)) throw new Error("role must be host or device");
    await this.authorize(request, role);
    const replace = new URL(request.url).searchParams.get("replace") === "1";
    const conflict = prepareRoleConnection(this.ctx, role, replace);
    if (conflict) return conflict;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role });
    const peerRole = role === "host" ? "device" : "host";
    server.send(JSON.stringify({ v: RELAY_PROTOCOL_VERSION, type: "relay.peer", online: this.ctx.getWebSockets(peerRole).length === 1 }));
    for (const peer of this.ctx.getWebSockets(peerRole)) {
      peer.send(JSON.stringify({ v: RELAY_PROTOCOL_VERSION, type: "relay.peer", online: true }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    const size = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (size > MAX_RELAY_MESSAGE_BYTES) {
      socket.close(1009, "message too large");
      return;
    }
    const role = socket.deserializeAttachment()?.role;
    const peerRole = role === "host" ? "device" : "host";
    for (const peer of this.ctx.getWebSockets(peerRole)) peer.send(message);
  }

  async webSocketClose(socket) {
    const role = socket.deserializeAttachment()?.role;
    if (this.ctx.getWebSockets(role).some((candidate) => candidate !== socket)) return;
    const peerRole = role === "host" ? "device" : "host";
    for (const peer of this.ctx.getWebSockets(peerRole)) {
      peer.send(JSON.stringify({ v: RELAY_PROTOCOL_VERSION, type: "relay.peer", online: false }));
    }
  }

  async webSocketError(socket) {
    await this.webSocketClose(socket);
  }

  async alarm() {
    const pairing = await this.storage.get("pairing");
    if (
      pairing &&
      ((!pairing.paired && pairing.expiresAt <= Date.now()) ||
        (pairing.paired && pairing.secretHash && pairing.collectionExpiresAt <= Date.now()))
    ) {
      await this.storage.deleteAll();
    }
  }

  async requirePairing() {
    const pairing = await this.storage.get("pairing");
    if (!pairing) throw new RelayHttpError("unknown device ID", 404, "NOT_FOUND");
    return pairing;
  }
}

export class PairRateLimiter {
  constructor(ctx) {
    this.storage = ctx.storage;
  }

  async fetch(request) {
    try {
      requireInternal(request);
      const now = Date.now();
      let bucket = (await this.storage.get("bucket")) ?? { count: 0, resetAt: now + PAIRING_RATE_WINDOW_MS };
      if (bucket.resetAt <= now) bucket = { count: 0, resetAt: now + PAIRING_RATE_WINDOW_MS };
      bucket.count += 1;
      await this.storage.put("bucket", bucket);
      if (bucket.count > PAIRING_RATE_LIMIT) {
        return json({ error: { code: "RATE_LIMITED", message: "too many pairing requests" }, resetAt: bucket.resetAt }, 429);
      }
      return json({ allowed: true, remaining: PAIRING_RATE_LIMIT - bucket.count, resetAt: bucket.resetAt });
    } catch (error) {
      return publicError(error);
    }
  }
}
