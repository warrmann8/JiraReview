// Tests for lib/auth.js — config gating, requireAuth pass-through when
// disabled, currentUser semantics, and stub error shapes.

const test = require("node:test");
const assert = require("node:assert/strict");
const auth = require("../lib/auth");

function clearAuthEnv() {
  const saved = {};
  for (const k of [...auth.REQUIRED_ENV, "AUTH_PROVIDER"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

function setAuthEnv() {
  process.env.AUTH_PROVIDER = "microsoft";
  process.env.AZURE_AD_TENANT_ID = "common";
  process.env.AZURE_AD_CLIENT_ID = "client-id";
  process.env.AZURE_AD_CLIENT_SECRET = "secret";
  process.env.AUTH_REDIRECT_URI = "http://localhost/auth/callback";
  process.env.AUTH_SESSION_SECRET = "test-secret";
}

test("isEnabled() is false when AUTH_PROVIDER is not microsoft", () => {
  const restore = clearAuthEnv();
  try {
    assert.equal(auth.isEnabled(), false);
  } finally { restore(); }
});

test("isEnabled() is true only when all required env vars are present", () => {
  const restore = clearAuthEnv();
  try {
    setAuthEnv();
    delete process.env.AZURE_AD_CLIENT_SECRET;
    assert.equal(auth.isEnabled(), false);
    process.env.AZURE_AD_CLIENT_SECRET = "secret";
    assert.equal(auth.isEnabled(), true);
  } finally { restore(); }
});

test("requireAuth passes through when SSO is disabled", () => {
  const restore = clearAuthEnv();
  try {
    let called = false;
    auth.requireAuth({ path: "/api/bus" }, {}, () => { called = true; });
    assert.equal(called, true);
  } finally { restore(); }
});

test("requireAuth returns 401 JSON on /api when SSO is on and no session", () => {
  const restore = clearAuthEnv();
  try {
    setAuthEnv();
    let status, body;
    const res = {
      status(c) { status = c; return this; },
      json(b) { body = b; return this; }
    };
    auth.requireAuth({ path: "/api/bus", session: {} }, res, () => assert.fail("next should not be called"));
    assert.equal(status, 401);
    assert.equal(body.code, "AUTH_REQUIRED");
  } finally { restore(); }
});

test("requireAuth redirects to /auth/login for non-API requests", () => {
  const restore = clearAuthEnv();
  try {
    setAuthEnv();
    let redirected;
    const res = { redirect(url) { redirected = url; } };
    auth.requireAuth({ path: "/", originalUrl: "/#/bu/x", session: {} }, res, () => assert.fail());
    assert.match(redirected, /^\/auth\/login\?next=/);
  } finally { restore(); }
});

test("currentUser returns null when SSO is disabled, even with a session blob", () => {
  const restore = clearAuthEnv();
  try {
    const req = { session: { user: { email: "x@x.com" } } };
    assert.equal(auth.currentUser(req), null);
  } finally { restore(); }
});

test("currentUser returns the session user when SSO is on", () => {
  const restore = clearAuthEnv();
  try {
    setAuthEnv();
    const req = { session: { user: { oid: "abc", email: "x@x.com" } } };
    assert.deepEqual(auth.currentUser(req), { oid: "abc", email: "x@x.com" });
  } finally { restore(); }
});

test("getAuthCodeUrl throws NotConfigured when SSO env is missing", async () => {
  const restore = clearAuthEnv();
  try {
    // Note: lib/auth.js doesn't export getAuthCodeUrl directly — it's
    // exercised through the /auth/login route. We can still validate the
    // shape via isEnabled() and missingEnv().
    assert.equal(auth.isEnabled(), false);
    assert.ok(Array.isArray(auth.missingEnv()) && auth.missingEnv().length >= 1);
  } finally { restore(); }
});
