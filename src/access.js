// HTTP access control for the hub.
//
// Two classes of requests are treated differently:
//   * event injection (`POST /api/onebot/event`, `POST /api/qq/event`) is a
//     privileged bridge that can claim any QQ user id, including an owner.
//     It therefore always needs a configured access token, presented in the
//     `x-access-token` header only (cookies and query strings are not accepted,
//     so a web page cannot forge events through a browser).
//   * everything else is either the token-protected console or, when no token
//     is configured, the loopback-only local console.
//
// Mutating console routes (any non-GET method under /api/, except the event
// injection bridge) additionally reject browser requests whose Origin/Referer
// does not match the request Host. The loopback rule alone is not enough: a
// malicious page can point a simple cross-origin POST (e.g. Content-Type:
// text/plain, no preflight) at http://127.0.0.1:3789 and the request still
// arrives from 127.0.0.1. Browsers always attach Origin to cross-origin POSTs
// and scripts cannot forge it, while native clients (curl, Invoke-RestMethod,
// Node fetch) send no Origin at all. Event injection is excluded because it is
// already restricted to an explicit `x-access-token` header, which a browser
// cannot attach without a preflight.
import { timingSafeEqual } from "node:crypto";

export const EVENT_INJECTION_PATHS = new Set(["/api/onebot/event", "/api/qq/event"]);

const PROXY_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
  "cf-connecting-ip",
  "cf-ray"
];

const COOKIE_NAME = "crc_access_token";

function isEventInjectionPath(path) {
  return EVENT_INJECTION_PATHS.has(String(path || ""));
}

export function isLoopbackAddress(address) {
  const address_ = String(address || "");
  if (!address_) return false;
  if (address_ === "::1") return true;
  if (address_.startsWith("::ffff:")) return isLoopbackAddress(address_.slice("::ffff:".length));
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address_);
}

function headerValue(req, name) {
  const value = req?.headers?.[name];
  if (Array.isArray(value)) return "";
  return typeof value === "string" ? value : "";
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function normalizeHost(host) {
  const value = String(host || "").trim().toLowerCase();
  if (!value) return "";
  if (value.endsWith(":80")) return value.slice(0, -3);
  if (value.endsWith(":443")) return value.slice(0, -4);
  return value;
}

// Origin is a serialized origin ("scheme://host[:port]", or the literal "null"
// for sandboxed/opaque contexts). Anything unparseable is treated as foreign.
function originHost(value) {
  try {
    return normalizeHost(new URL(String(value)).host);
  } catch {
    return "";
  }
}

// Wildcard bind addresses do not name a host, so they cannot vouch for a Host
// header on their own.
const WILDCARD_BIND_ADDRESSES = new Set(["0.0.0.0", "::", "[::]"]);

// Parse a Host header (or a configured bind/allowed name) as plain host[:port].
// Returns null for userinfo, paths, multiple hosts, or an invalid port.
function parseHostValue(value) {
  const host = normalizeHost(value);
  if (!host || /[\s/\\@?#]/.test(host)) return null;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return null;
    const hostname = host.slice(1, end);
    const rest = host.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    if (!/^[0-9a-f:]+$/i.test(hostname)) return null;
    return { host, hostname };
  }
  const parts = host.split(":");
  if (parts.length > 2) return null;
  const [hostname, port] = parts;
  if (!hostname || (port !== undefined && !/^\d{1,5}$/.test(port))) return null;
  if (!/^[a-z0-9._-]+$/.test(hostname)) return null;
  return { host, hostname };
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function configuredHostnames({ host = "", allowedHosts = [] } = {}) {
  const values = [host, ...(Array.isArray(allowedHosts) ? allowedHosts : [allowedHosts])];
  const names = new Set();
  for (const value of values) {
    for (const part of String(value || "").split(",")) {
      const parsed = parseHostValue(part);
      if (!parsed || WILDCARD_BIND_ADDRESSES.has(parsed.hostname)) continue;
      names.add(parsed.hostname);
    }
  }
  return names;
}

// Trust only the Host header, never X-Forwarded-Host: no trusted-proxy contract
// exists here, and a proxy header must not be able to turn an attacker hostname
// into a same-origin peer. `authenticated` is set only after token validation,
// which keeps arbitrary public tunnel hostnames usable for remote access.
function trustedRequestHost(req, { host = "", allowedHosts = [], authenticated = false } = {}) {
  const parsed = parseHostValue(headerValue(req, "host"));
  if (!parsed) return "";
  if (authenticated || isLoopbackHostname(parsed.hostname)) return parsed.host;
  return configuredHostnames({ host, allowedHosts }).has(parsed.hostname) ? parsed.host : "";
}

function originMatchesHost(req, value, options) {
  const host = originHost(value);
  const requestHost = trustedRequestHost(req, options);
  return Boolean(host) && Boolean(requestHost) && host === requestHost;
}

/**
 * True for state-changing console API calls whose browser origin must be
 * checked. Safe methods and the token-only event injection bridge are exempt.
 */
export function isMutatingApiRequest(req, path) {
  const method = String(req?.method || "GET").toUpperCase();
  if (SAFE_METHODS.has(method)) return false;
  const pathname = String(path || "").split("?")[0];
  if (!pathname.startsWith("/api/")) return false;
  return !isEventInjectionPath(pathname);
}

/**
 * Reject cross-origin browser writes. Missing Origin and Referer means a native
 * client (curl, Invoke-RestMethod, Node fetch), which is allowed to continue to
 * the token/loopback checks. When Origin is present it is authoritative; Referer
 * is only a fallback for old browsers.
 *
 * @param {{method?: string, headers?: object}} req
 * @param {string} path
 * @param {{host?: string, allowedHosts?: string[], authenticated?: boolean}} [options]
 * @returns {{allowed: true} | {allowed: false, status: number, reason: string}}
 */
export function evaluateCsrf(req, path, options = {}) {
  if (!isMutatingApiRequest(req, path)) return { allowed: true };
  const headers = req?.headers || {};
  if (Object.prototype.hasOwnProperty.call(headers, "origin")) {
    const origin = headers.origin;
    const allowed = typeof origin === "string" && originMatchesHost(req, origin, options);
    return allowed
      ? { allowed: true }
      : { allowed: false, status: 403, reason: "Cross-origin request rejected" };
  }
  if (Object.prototype.hasOwnProperty.call(headers, "referer")) {
    const referer = headers.referer;
    const allowed = typeof referer === "string" && originMatchesHost(req, referer, options);
    return allowed
      ? { allowed: true }
      : { allowed: false, status: 403, reason: "Cross-origin request rejected" };
  }
  return { allowed: true };
}

function safeEqual(presented, expected) {
  if (!presented || !expected) return false;
  const left = Buffer.from(String(presented), "utf8");
  const right = Buffer.from(String(expected), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function tokenFromHeader(req) {
  return headerValue(req, "x-access-token");
}

export function tokenFromCookie(req) {
  const cookie = headerValue(req, "cookie");
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${COOKIE_NAME}=`)) continue;
    try {
      return decodeURIComponent(trimmed.slice(COOKIE_NAME.length + 1));
    } catch {
      return "";
    }
  }
  return "";
}

export function hasProxyHeaders(req) {
  return PROXY_HEADERS.some((name) => Boolean(headerValue(req, name)));
}

export function hasValidToken(req, token) {
  if (!token) return false;
  return safeEqual(tokenFromHeader(req), token) || safeEqual(tokenFromCookie(req), token);
}

/**
 * Decide whether a request may proceed.
 *
 * @param {{headers?: object, socket?: {remoteAddress?: string}}} req
 * @param {{token?: string, path?: string, host?: string, allowedHosts?: string[]}} options
 * @returns {{allowed: true} | {allowed: false, status: number, reason: string, loginPage?: boolean}}
 */
export function evaluateAccess(req, { token = "", path = "", host = "", allowedHosts = [] } = {}) {
  const authenticated = Boolean(token) && hasValidToken(req, token);
  const csrf = evaluateCsrf(req, path, { host, allowedHosts, authenticated });
  if (!csrf.allowed) return csrf;

  const injection = isEventInjectionPath(path);

  if (injection) {
    if (!token) {
      return {
        allowed: false,
        status: 403,
        reason: "Event injection is disabled until CODEX_REMOTE_CONTACT_ACCESS_TOKEN is configured"
      };
    }
    if (!safeEqual(tokenFromHeader(req), token)) {
      return { allowed: false, status: 401, reason: "Unauthorized" };
    }
    return { allowed: true };
  }

  if (token) {
    if (authenticated) return { allowed: true };
    return {
      allowed: false,
      status: 401,
      reason: "Unauthorized",
      loginPage: true
    };
  }

  // No token configured: the console stays usable from the local machine only.
  // Requests arriving through a tunnel/proxy carry forwarding headers even
  // though they connect from 127.0.0.1, so they are rejected as well.
  if (isLoopbackAddress(req?.socket?.remoteAddress) && !hasProxyHeaders(req)) {
    // A browser tricked by DNS rebinding also connects from 127.0.0.1, but its
    // Host header still names the attacker domain. Only the bind address,
    // loopback aliases, and explicitly allowed names may reach this console.
    if (!trustedRequestHost(req, { host, allowedHosts })) {
      return { allowed: false, status: 403, reason: "Untrusted Host header" };
    }
    return { allowed: true };
  }
  return {
    allowed: false,
    status: 401,
    reason: "Remote access requires CODEX_REMOTE_CONTACT_ACCESS_TOKEN"
  };
}
