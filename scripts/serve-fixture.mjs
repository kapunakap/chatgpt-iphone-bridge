#!/usr/bin/env node

import fs from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";

const htmlPath = fileURLToPath(new URL("../fixtures/safari/index.html", import.meta.url));
const html = await fs.readFile(htmlPath);
const host = process.env.FIXTURE_HOST ?? "127.0.0.1";
const requestedPort = Number(process.env.FIXTURE_PORT ?? "4173");

if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  throw new Error("FIXTURE_PORT must be an integer from 0 to 65535");
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method !== "GET" || !new Set(["/", "/index.html"]).has(url.pathname)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": html.length,
  });
  response.end(html);
});

server.listen(requestedPort, host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  console.log(`FIXTURE_URL=http://${host}:${port}/`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
