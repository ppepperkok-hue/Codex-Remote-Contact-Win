import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { evaluateAccess } from "../src/access.js";

const TOKEN = "host-trust-token";

function send(port, { method = "GET", path = "/api/state", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// Minimal stand-in for src/server.js: the real evaluateAccess gate plus a
// record of which mutating requests reached a handler.
async function withHub({ token = "", host = "", allowedHosts = [] }, run) {
  const hits = [];
  const server = createServer(async (req, res) => {
    const path = (req.url || "").split("?")[0];
    const decision = evaluateAccess(req, { token, path, host, allowedHosts });
    if (!decision.allowed) {
      res.writeHead(decision.status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: decision.reason }));
      return;
    }
    if (req.method === "POST" && path.startsWith("/api/")) hits.push(path);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run({ port, hits });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function fakeRequest({ method = "POST", path = "/api/services/start", headers = {}, remoteAddress = "127.0.0.1" } = {}) {
  return { method, url: path, headers, socket: { remoteAddress } };
}

test("DNS rebinding: attacker Host/Origin pair cannot mutate the no-token console", { timeout: 5000 }, async () => {
  await withHub({}, async ({ port, hits }) => {
    const response = await send(port, {
      method: "POST",
      path: "/api/services/start",
      headers: {
        Host: `evil.example:${port}`,
        Origin: `http://evil.example:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "text/plain"
      },
      body: "service=napcat"
    });
    assert.equal(response.status, 403);
    assert.equal(hits.length, 0);
  });
});

test("DNS rebinding: attacker Host cannot read the no-token console state", { timeout: 5000 }, async () => {
  await withHub({}, async ({ port }) => {
    const response = await send(port, {
      path: "/api/state",
      headers: {
        Host: `evil.example:${port}`,
        Origin: `http://evil.example:${port}`,
        "Sec-Fetch-Site": "same-origin"
      }
    });
    assert.equal(response.status, 403);
  });
});

test("X-Forwarded-Host is not accepted as a same-origin source", { timeout: 5000 }, async () => {
  await withHub({ token: TOKEN }, async ({ port, hits }) => {
    const response = await send(port, {
      method: "POST",
      path: "/api/services/start",
      headers: {
        Host: `127.0.0.1:${port}`,
        "X-Forwarded-Host": `evil.example:${port}`,
        Origin: `http://evil.example:${port}`,
        "Content-Type": "text/plain",
        cookie: `crc_access_token=${encodeURIComponent(TOKEN)}`
      },
      body: "service=napcat"
    });
    assert.equal(response.status, 403);
    assert.equal(hits.length, 0);
  });
});

test("legitimate loopback dashboard keeps working without a token", { timeout: 5000 }, async () => {
  await withHub({}, async ({ port, hits }) => {
    for (const name of ["127.0.0.1", "localhost"]) {
      const read = await send(port, { path: "/api/state", headers: { Host: `${name}:${port}` } });
      assert.equal(read.status, 200, `${name} read must stay allowed`);
    }
    const write = await send(port, {
      method: "POST",
      path: "/api/services/start",
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ service: "napcat" })
    });
    assert.equal(write.status, 200);
    assert.deepEqual(hits, ["/api/services/start"]);
  });
});

test("configured bound and allowed host names are trusted without a token", { timeout: 5000 }, async () => {
  await withHub({ host: "mybox.local", allowedHosts: ["dashboard.lan"] }, async ({ port, hits }) => {
    for (const name of ["mybox.local", "dashboard.lan"]) {
      const response = await send(port, {
        method: "POST",
        path: "/api/wake",
        headers: {
          Host: `${name}:${port}`,
          Origin: `http://${name}:${port}`,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "text/plain"
        },
        body: ""
      });
      assert.equal(response.status, 200, `${name} must stay allowed`);
    }
    assert.deepEqual(hits, ["/api/wake", "/api/wake"]);
  });
});

test("token-auth remote access keeps working through an unknown tunnel host", { timeout: 5000 }, async () => {
  await withHub({ token: TOKEN }, async ({ port, hits }) => {
    const host = "random-name.trycloudflare.com";
    const response = await send(port, {
      method: "POST",
      path: "/api/services/start",
      headers: {
        Host: host,
        Origin: `https://${host}`,
        "Content-Type": "text/plain",
        "cf-connecting-ip": "203.0.113.7",
        cookie: `crc_access_token=${encodeURIComponent(TOKEN)}`
      },
      body: "service=napcat"
    });
    assert.equal(response.status, 200);
    assert.deepEqual(hits, ["/api/services/start"]);
  });
});

test("token-auth LAN and native clients still pass with a non-loopback address", () => {
  const sameOrigin = fakeRequest({
    path: "/api/wake",
    remoteAddress: "192.168.1.50",
    headers: {
      host: "192.168.1.50:3789",
      origin: "http://192.168.1.50:3789",
      "x-access-token": TOKEN
    }
  });
  assert.equal(evaluateAccess(sameOrigin, { token: TOKEN, path: "/api/wake" }).allowed, true);

  const native = fakeRequest({
    path: "/api/wake",
    remoteAddress: "192.168.1.50",
    headers: { host: "192.168.1.50:3789", "x-access-token": TOKEN }
  });
  assert.equal(evaluateAccess(native, { token: TOKEN, path: "/api/wake" }).allowed, true);
});

test("untrusted Host is rejected even for native no-token clients", () => {
  const decision = evaluateAccess(
    fakeRequest({ path: "/api/wake", headers: { host: "evil.example:3789" } }),
    { token: "", path: "/api/wake" }
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, 403);
});
