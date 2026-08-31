import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import {
  CELLULAR_MAX_MESSAGE_BYTES,
  ReplayCache,
  createSignedHello,
  deriveSessionKey,
  openPayload,
  sealPayload,
  validateFreshPayload,
  verifyPeerHello,
} from "./cellular-crypto.mjs";
import { validateHostIdentity } from "./cellular-identity.mjs";

function relayWebSocketUrl(relayUrl, deviceId, { allowInsecureLoopback = false } = {}) {
  const url = new URL(relayUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (
    allowInsecureLoopback &&
    url.protocol === "http:" &&
    new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)
  ) {
    url.protocol = "ws:";
  }
  const insecureLoopback =
    allowInsecureLoopback && url.protocol === "ws:" && new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname);
  if (url.protocol !== "wss:" && !insecureLoopback) {
    throw new Error("cellular relay URL must use https or wss");
  }
  url.pathname = `/v1/devices/${encodeURIComponent(deviceId)}/connect`;
  url.search = "role=host&replace=1";
  url.hash = "";
  return url;
}

function errorWithCode(message, code, retryable = true) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

export class CellularRelayClient extends EventEmitter {
  constructor(options) {
    super();
    this.identity = validateHostIdentity(options.identity);
    this.relayUrl = options.relayUrl;
    this.allowInsecureLoopback = options.allowInsecureLoopback === true;
    this.now = options.now ?? Date.now;
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url, websocketOptions) => new WebSocket(url, websocketOptions));
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? [1000, 2000, 4000, 8000, 15_000, 30_000];
    this.socket = null;
    this.started = false;
    this.closed = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.relayConnected = false;
    this.deviceOnline = false;
    this.peerStatusKnown = false;
    this.secureReady = false;
    this.handshake = null;
    this.peerConnectionId = null;
    this.key = null;
    this.pending = new Map();
    this.replayCache = new ReplayCache({ now: this.now });
  }

  status() {
    return {
      relayConnected: this.relayConnected,
      deviceOnline: this.deviceOnline,
      secureReady: this.secureReady,
    };
  }

  start() {
    if (this.closed) throw new Error("cellular relay client is closed");
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  connect() {
    if (this.closed || this.socket) return;
    const url = relayWebSocketUrl(this.relayUrl, this.identity.deviceId, {
      allowInsecureLoopback: this.allowInsecureLoopback,
    });
    const socket = this.webSocketFactory(url, {
      headers: { Authorization: `Bearer ${this.identity.authToken}` },
      maxPayload: CELLULAR_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    });
    this.socket = socket;

    socket.on("open", () => this.onOpen(socket));
    socket.on("message", (data) => this.onMessage(socket, data));
    socket.on("error", (error) => this.emit("warning", error));
    socket.on("close", (code, reason) => this.onClose(socket, code, reason));
  }

  onOpen(socket) {
    if (socket !== this.socket) return;
    this.reconnectAttempt = 0;
    this.relayConnected = true;
    this.resetSecureChannel();
    this.emit("relay", this.status());
  }

  onMessage(socket, raw) {
    if (socket !== this.socket) return;
    const size = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
    if (size > CELLULAR_MAX_MESSAGE_BYTES) {
      socket.close(1009, "message too large");
      return;
    }
    let message;
    try {
      message = JSON.parse(Buffer.from(raw).toString("utf8"));
      this.handleMessage(message);
    } catch (error) {
      this.emit("warning", error);
      socket.close(1008, "invalid protocol message");
    }
  }

  handleMessage(message) {
    if (message?.v === 1 && message?.type === "relay.peer") {
      const wasKnown = this.peerStatusKnown;
      const wasOnline = this.deviceOnline;
      this.peerStatusKnown = true;
      this.deviceOnline = message.online === true;
      if (!this.deviceOnline) this.resetSecureChannel();
      this.emit("device", this.status());
      if ((!wasKnown || !wasOnline) && this.deviceOnline) this.sendHello();
      return;
    }

    if (message?.v === 1 && message?.type === "hello") {
      verifyPeerHello(message, {
        deviceId: this.identity.deviceId,
        expectedRole: "device",
        peerSigningPublicKey: this.identity.peerSigningPublicKey,
        now: this.now,
      });
      const peerChanged = this.peerConnectionId !== null && this.peerConnectionId !== message.connectionId;
      if (!this.handshake || peerChanged) {
        this.key = null;
        this.handshake = null;
        this.sendHello();
      }
      this.key = deriveSessionKey({
        localEcdh: this.handshake.ecdh,
        localHello: this.handshake.hello,
        peerHello: message,
      });
      this.peerConnectionId = message.connectionId;
      this.sendSealed(this.message("secure_ready", {}, 30_000));
      return;
    }

    if (message?.v === 1 && message?.type === "sealed") {
      if (!this.key) throw new Error("received sealed cellular message before handshake");
      const payload = validateFreshPayload(openPayload(this.key, this.identity.deviceId, message), {
        now: this.now,
        replayCache: this.replayCache,
      });
      this.handlePayload(payload);
      return;
    }
    throw new Error("unsupported cellular relay message");
  }

  handlePayload(payload) {
    if (payload.type === "secure_ready") {
      if (!this.secureReady) {
        this.secureReady = true;
        this.deviceOnline = true;
        this.emit("ready", this.status());
      }
      return;
    }
    if (payload.type === "response") {
      const pending = this.pending.get(payload.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(payload.requestId);
      if (payload.ok === true) pending.resolve(payload.result ?? {});
      else pending.reject(errorWithCode(payload.error?.message ?? "cellular command failed", payload.error?.code ?? "REMOTE_ERROR", false));
      return;
    }
    if (payload.type === "event") {
      this.emit("event", payload.name, payload.data ?? {});
      return;
    }
    throw new Error("unsupported encrypted cellular payload");
  }

  sendHello() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.handshake = createSignedHello(this.identity, this.identity.deviceId, "host", this.now);
    this.socket.send(JSON.stringify(this.handshake.hello));
  }

  sendSealed(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.key) {
      throw errorWithCode("cellular device is offline", "DEVICE_OFFLINE");
    }
    this.socket.send(JSON.stringify(sealPayload(this.key, this.identity.deviceId, payload)));
  }

  message(type, fields, ttlMs) {
    const sentAt = this.now();
    return {
      type,
      messageId: randomUUID(),
      sentAt,
      expiresAt: sentAt + ttlMs,
      ...fields,
    };
  }

  request(command, args, { timeoutMs = 15_000 } = {}) {
    if (!this.secureReady) return Promise.reject(errorWithCode("cellular device is not ready", "DEVICE_OFFLINE"));
    const requestId = randomUUID();
    const payload = this.message("request", { requestId, command, args }, timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(errorWithCode(`cellular command ${command} timed out`, "COMMAND_TIMEOUT"));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.sendSealed(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  resetSecureChannel() {
    const wasReady = this.secureReady;
    this.secureReady = false;
    this.key = null;
    this.handshake = null;
    this.peerConnectionId = null;
    if (wasReady) this.emit("interrupted", this.status());
  }

  onClose(socket, code, reason) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.relayConnected = false;
    this.deviceOnline = false;
    this.peerStatusKnown = false;
    this.resetSecureChannel();
    const error = errorWithCode(
      `cellular relay disconnected (${code}${reason?.length ? `: ${reason.toString()}` : ""})`,
      "RELAY_DISCONNECTED",
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("relay", this.status());
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.closed || !this.started || this.reconnectTimer) return;
    const index = Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1);
    const delay = this.reconnectDelaysMs[index];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async close() {
    this.closed = true;
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(errorWithCode("cellular relay client closed", "CLIENT_CLOSED", false));
    }
    this.pending.clear();
    if (socket && socket.readyState < WebSocket.CLOSED) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          socket.terminate?.();
          finish();
        }, 1000);
        timer.unref?.();
        socket.once?.("close", finish);
        if (socket.readyState < WebSocket.CLOSING) socket.close(1000, "bridge shutdown");
      });
    }
  }
}

export { relayWebSocketUrl };
