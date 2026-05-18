// Microsoft Entra ID (Azure AD) SSO scaffolding.
//
// This module exposes the helpers and Express middleware the rest of the
// app calls into for authentication. The two operations that actually talk
// to Microsoft (`getAuthCodeUrl` and `acquireTokenByCode`) are stubs that
// throw AuthNotImplementedError with the exact MSAL call to make.
// `requireAuth` and `currentUser` are real — they work today by reading
// the session, so as soon as the two MSAL calls are filled in the rest of
// the flow works end-to-end.
//
// Reference: @azure/msal-node ConfidentialClientApplication.
//   Auth code flow:  client.getAuthCodeUrl(req) -> redirect user to MSFT
//   Callback:        client.acquireTokenByCode(req) -> get id_token + claims
//   Session:         store claims (oid, preferred_username, name, email)
//   Logout:          clear session, redirect to MSFT logout endpoint
//
// Required Entra app registration:
//   - Single-tenant or multi-tenant (set TENANT_ID accordingly; "common"
//     for multi-tenant)
//   - Web platform with redirect URI matching AUTH_REDIRECT_URI
//   - "ID tokens" enabled under Authentication > Implicit grant
//   - Optionally: API permissions for Microsoft Graph (User.Read) if you
//     want to fetch group membership later
//
// Env vars (see .env.example):
//   AUTH_PROVIDER=microsoft       enable SSO (anything else => disabled)
//   AZURE_AD_TENANT_ID            "common" | a GUID | a verified domain
//   AZURE_AD_CLIENT_ID            App registration's Application (client) ID
//   AZURE_AD_CLIENT_SECRET        Client secret (or use a certificate)
//   AUTH_REDIRECT_URI             http://localhost:4173/auth/callback (dev)
//                                 https://your-host/auth/callback (prod)
//   AUTH_SESSION_SECRET           Long random string for session signing

const REQUIRED_ENV = [
  "AZURE_AD_TENANT_ID",
  "AZURE_AD_CLIENT_ID",
  "AZURE_AD_CLIENT_SECRET",
  "AUTH_REDIRECT_URI",
  "AUTH_SESSION_SECRET"
];

class AuthNotConfiguredError extends Error {
  constructor(missing) {
    super(`Microsoft SSO not configured. Missing env: ${missing.join(", ")}. See AUTH-HANDOFF.md.`);
    this.code = "AUTH_NOT_CONFIGURED";
    this.missing = missing;
  }
}

class AuthNotImplementedError extends Error {
  constructor(fn, doc) {
    super(`Auth function ${fn} is not yet implemented. ${doc} See AUTH-HANDOFF.md.`);
    this.code = "AUTH_NOT_IMPLEMENTED";
    this.fn = fn;
  }
}

function isEnabled() {
  if ((process.env.AUTH_PROVIDER || "").toLowerCase() !== "microsoft") return false;
  return REQUIRED_ENV.every(k => !!process.env[k]);
}

function missingEnv() {
  return REQUIRED_ENV.filter(k => !process.env[k]);
}

function authority() {
  const tenant = process.env.AZURE_AD_TENANT_ID || "common";
  return `https://login.microsoftonline.com/${tenant}`;
}

// MSAL client cached per process. Lazy so the dep is only loaded when
// SSO is enabled; the rest of the app can run without @azure/msal-node.
let _msalClient = null;
function getMsalClient() {
  if (!isEnabled()) {
    throw new AuthNotConfiguredError(missingEnv());
  }
  if (_msalClient) return _msalClient;
  let msal;
  try {
    msal = require("@azure/msal-node");
  } catch (e) {
    throw new Error("@azure/msal-node is not installed. Run `npm install @azure/msal-node`. See AUTH-HANDOFF.md.");
  }
  _msalClient = new msal.ConfidentialClientApplication({
    auth: {
      clientId: process.env.AZURE_AD_CLIENT_ID,
      authority: authority(),
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET
    },
    system: { loggerOptions: { logLevel: msal.LogLevel.Warning } }
  });
  return _msalClient;
}

// ---- Stubs the implementer fills in ----

/**
 * Build the Microsoft authorize URL and redirect the user there.
 * The user signs in, then Microsoft posts to AUTH_REDIRECT_URI with a code.
 */
async function getAuthCodeUrl(_state) {
  getMsalClient();
  // TODO:
  //   const client = getMsalClient();
  //   return await client.getAuthCodeUrl({
  //     scopes: ["openid", "profile", "email", "User.Read"],
  //     redirectUri: process.env.AUTH_REDIRECT_URI,
  //     state: _state,
  //     prompt: "select_account"
  //   });
  throw new AuthNotImplementedError("getAuthCodeUrl",
    `Call msal.ConfidentialClientApplication.getAuthCodeUrl({ scopes, redirectUri, state }).`);
}

/**
 * Exchange the authorization code for tokens. Returns the parsed id-token
 * claims that should be stored in the session.
 */
async function acquireTokenByCode(_code, _state) {
  getMsalClient();
  // TODO:
  //   const client = getMsalClient();
  //   const result = await client.acquireTokenByCode({
  //     code: _code,
  //     scopes: ["openid", "profile", "email", "User.Read"],
  //     redirectUri: process.env.AUTH_REDIRECT_URI
  //   });
  //   return result.account ? {
  //     oid: result.account.homeAccountId.split(".")[0],   // stable user id
  //     name: result.account.name,
  //     email: result.account.username,                      // upn / email
  //     tenantId: result.account.tenantId
  //   } : null;
  throw new AuthNotImplementedError("acquireTokenByCode",
    `Call msal.acquireTokenByCode({ code, scopes, redirectUri }) and return the account claims.`);
}

// ---- Real (works today) ----

/**
 * Express middleware. If SSO is enabled, requires a session user.
 * If SSO is disabled, falls through so the existing actor-name input path
 * keeps working in dev / single-user mode.
 */
function requireAuth(req, res, next) {
  if (!isEnabled()) return next();
  if (req.session && req.session.user) return next();
  // For API calls, return 401 JSON. For nav requests, redirect to /auth/login.
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({
      error: "Authentication required",
      code: "AUTH_REQUIRED",
      login_url: "/auth/login"
    });
  }
  const next_url = encodeURIComponent(req.originalUrl || "/");
  return res.redirect(`/auth/login?next=${next_url}`);
}

/** Get the current user from the session, or null. */
function currentUser(req) {
  if (!isEnabled()) return null;
  return (req.session && req.session.user) || null;
}

/** Wire `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/me`. */
function mount(app) {
  app.get("/auth/me", (req, res) => {
    res.json({
      enabled: isEnabled(),
      user: currentUser(req),
      provider: isEnabled() ? "microsoft" : null
    });
  });

  app.get("/auth/login", async (req, res) => {
    if (!isEnabled()) {
      return res.status(501).json({
        error: "SSO not configured",
        code: "AUTH_NOT_CONFIGURED",
        missing: missingEnv(),
        handoff: "See AUTH-HANDOFF.md."
      });
    }
    try {
      const next_url = req.query.next || "/";
      req.session.auth_next = String(next_url);
      const url = await getAuthCodeUrl(req.sessionID);
      res.redirect(url);
    } catch (e) {
      authErrorResponse(res, e);
    }
  });

  app.get("/auth/callback", async (req, res) => {
    if (!isEnabled()) {
      return res.status(501).json({ error: "SSO not configured", code: "AUTH_NOT_CONFIGURED" });
    }
    try {
      const user = await acquireTokenByCode(req.query.code, req.query.state);
      if (!user) throw new Error("No account claims returned");
      req.session.user = user;
      const next_url = (req.session && req.session.auth_next) || "/";
      delete req.session.auth_next;
      res.redirect(next_url);
    } catch (e) {
      authErrorResponse(res, e);
    }
  });

  app.post("/auth/logout", (req, res) => {
    if (req.session) req.session.destroy(() => res.json({ ok: true }));
    else res.json({ ok: true });
  });
}

function authErrorResponse(res, e) {
  if (e && e.code === "AUTH_NOT_CONFIGURED") {
    return res.status(501).json({
      error: e.message, code: e.code, missing: e.missing, handoff: "See AUTH-HANDOFF.md."
    });
  }
  if (e && e.code === "AUTH_NOT_IMPLEMENTED") {
    return res.status(501).json({
      error: e.message, code: e.code, fn: e.fn, handoff: "See AUTH-HANDOFF.md."
    });
  }
  return res.status(500).json({ error: String((e && e.message) || e) });
}

module.exports = {
  isEnabled,
  missingEnv,
  REQUIRED_ENV,
  requireAuth,
  currentUser,
  mount,
  AuthNotConfiguredError,
  AuthNotImplementedError
};
