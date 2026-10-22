import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { evaluateAccess, evaluateCsrf } from "../src/access.js";

const TOKEN = "csrf-test-token";

function fakeRequest({ method = "POST", path = "/api/services/start", headers = {} } = {}) {
  return { method, url: path, headers, socket: { remoteAddress: "127.0.0.1" } };
}

function hubUrl(port) {
  return `http://127.0.0.1:${port}`;
}

// Minimal stand-in for src/server.js: same evaluateAccess gate, a single
// mutating handler, and a record of which mutating requests reached it.
async function withHub(token, run) {
  const hits = [];
  const server = createServer(async (req, res) => {
    const path = (req.url || "").split("?")[0];
    const decision = evaluateAccess(req, { token, path });
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
    await run({ base: hubUrl(port), hits });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("mutating API: cross-origin Origin is rejected", () => {
  for (const path of ["/api/services/start", "/api/wake", "/api/channel"]) {
    const decision = evaluateCsrf(fakeRequest({ path, headers: { origin: "http://evil.example" } }), path);
    assert.equal(decision.allowed, false, `${path} must reject a foreign origin`);
    assert.equal(decision.status, 403);
  }
});

test("mutating API: same-origin Origin is allowed", () => {
  const headers = { origin: "http://127.0.0.1:3789", host: "127.0.0.1:3789" };
  for (const path of ["/api/services/start", "/api/wake"]) {
    assert.equal(evaluateCsrf(fakeRequest({ path, headers }), path).allowed, true);
  }
  assert.equal(
    evaluateCsrf(fakeRequest({ headers: { origin: "http://localhost:3789", host: "localhost:3789" } }), "/api/wake")
      .allowed,
    true
  );
});

test("mutating API: native clients without Origin/Referer are allowed", () => {
  // curl / Invoke-RestMethod / Node fetch do not send either header.
  assert.equal(evaluateCsrf(fakeRequest({ headers: { host: "127.0.0.1:3789" } }), "/api/services/start").allowed, true);
});

test("mutating API: cross-origin Referer is rejected when Origin is absent", () => {
  const foreign = evaluateCsrf(
    fakeRequest({ headers: { host: "127.0.0.1:3789", referer: "http://evil.example/page" } }),
    "/api/wake"
  );
  assert.equal(foreign.allowed, false);
  assert.equal(foreign.status, 403);

  const local = evaluateCsrf(
    fakeRequest({ headers: { host: "127.0.0.1:3789", referer: "http://127.0.0.1:3789/dashboard.html" } }),
    "/api/wake"
  );
  assert.equal(local.allowed, true);
});

test("mutating API: opaque Origin null is rejected", () => {
  const decision = evaluateCsrf(fakeRequest({ headers: { host: "127.0.0.1:3789", origin: "null" } }), "/api/wake");
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, 403);
});

test("safe methods and event injection keep their existing auth path", () => {
  assert.equal(evaluateCsrf(fakeRequest({ method: "GET", headers: { origin: "http://evil.example" } }), "/api/state").allowed, true);
  // Event injection is exempt from the origin check; the header-only token is
  // what protects it (a browser cannot add that header without a preflight).
  assert.equal(
    evaluateCsrf(
      fakeRequest({ path: "/api/onebot/event", headers: { origin: "http://evil.example" } }),
      "/api/onebot/event"
    ).allowed,
    true
  );
});

test("HTTP: no token, cross-origin simple POST never reaches the handler", { timeout: 5000 }, async () => {
  await withHub("", async ({ base, hits }) => {
    const response = await fetch(`${base}/api/services/start`, {
      method: "POST",
      // text/plain is a CORS "simple request": no preflight, so the browser
      // sends it without asking the hub for permission.
      headers: { "Content-Type": "text/plain", Origin: "http://evil.example" },
      body: "service=napcat"
    });
    assert.equal(response.status, 403);
    assert.equal(hits.length, 0);

    const wake = await fetch(`${base}/api/wake`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "http://evil.example" },
      body: ""
    });
    assert.equal(wake.status, 403);
    assert.equal(hits.length, 0);
  });
});

test("HTTP: no token, same-origin and native POSTs still reach the handler", { timeout: 5000 }, async () => {
  await withHub("", async ({ base, hits }) => {
    const sameOrigin = await fetch(`${base}/api/services/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ service: "napcat" })
    });
    assert.equal(sameOrigin.status, 200);
    assert.deepEqual(hits, ["/api/services/start"]);

    // CLI/curl style: Host header only, no Origin/Referer.
    const native = await fetch(`${base}/api/wake`, { method: "POST" });
    assert.equal(native.status, 200);
    assert.deepEqual(hits, ["/api/services/start", "/api/wake"]);
  });
});

test("HTTP: configured token, cookie-authorized cross-origin POST is rejected", { timeout: 5000 }, async () => {
  await withHub(TOKEN, async ({ base, hits }) => {
    const crossOrigin = await fetch(`${base}/api/services/start`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Origin: "http://evil.example",
        cookie: `crc_access_token=${encodeURIComponent(TOKEN)}`
      },
      body: "service=napcat"
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(hits.length, 0);
  });
});

test("HTTP: configured token, authorized same-origin POST is accepted", { timeout: 5000 }, async () => {
  await withHub(TOKEN, async ({ base, hits }) => {
    const sameOrigin = await fetch(`${base}/api/services/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: base,
        "x-access-token": TOKEN
      },
      body: JSON.stringify({ service: "napcat" })
    });
    assert.equal(sameOrigin.status, 200);
    assert.deepEqual(hits, ["/api/services/start"]);

    const native = await fetch(`${base}/api/wake`, {
      method: "POST",
      headers: { "x-access-token": TOKEN }
    });
    assert.equal(native.status, 200);
    assert.deepEqual(hits, ["/api/services/start", "/api/wake"]);
  });
});
