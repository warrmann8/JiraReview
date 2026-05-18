# Microsoft SSO — Handoff

**Audience:** the engineer who will complete the Microsoft Entra ID (Azure
AD) sign-in flow.
**Status:** scaffolding is in place. Session middleware is wired, the
`/auth/*` routes are mounted, `requireAuth` middleware is in front of all
`/api` routes, and the appbar swaps to a Sign-in / Signed-in widget when
SSO is enabled. Two MSAL calls are stubbed — fill them in and SSO is live.

## What's already done

- `lib/auth.js` — module with `isEnabled()`, `requireAuth(req, res, next)`,
  `currentUser(req)`, and the route mounts (`mount(app)`).
- `server.js` — `express-session` configured (8-hour cookie, httpOnly,
  sameSite=lax, secure in production). `auth.mount(app)` wires
  `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/me`. Middleware
  gates `/api` behind a session user when SSO is enabled.
- `/api/decision` records the SSO user's email + Entra `oid` on every
  override, so the audit log carries real identity instead of the
  client-typed actor field.
- `.env.example` documents the five required vars.
- Frontend appbar shows "Signed in as X · Sign out" when authenticated,
  "Sign in with Microsoft" when not. Falls back to the actor input box
  when SSO is disabled (dev mode).

## What you need to do

Exactly two functions in `lib/auth.js`, both marked with `TODO:` and the
exact MSAL call to make:

| Function | Returns | Maps to |
|---|---|---|
| `getAuthCodeUrl(state)` | A Microsoft authorize URL the user gets redirected to. | `msal.ConfidentialClientApplication.getAuthCodeUrl({ scopes, redirectUri, state })` |
| `acquireTokenByCode(code, state)` | Account claims `{ oid, name, email, tenantId }` to store in the session. | `msal.ConfidentialClientApplication.acquireTokenByCode({ code, scopes, redirectUri })` |

`getMsalClient()` already constructs the `ConfidentialClientApplication`
with the right authority and credentials. You just call it.

`@azure/msal-node` is already in `package.json` (`^2.16.0`).

## Microsoft Entra app registration

The Azure / Entra admin needs to register a web app. Steps:

1. **Entra admin center** → **App registrations** → **New registration**.
2. **Name:** "Daedalus Scrub" (or whatever).
3. **Supported account types:** "Accounts in this organizational directory
   only (single tenant)" — unless multi-tenant is needed.
4. **Redirect URI:** Web platform, value matches `AUTH_REDIRECT_URI`:
   - Dev: `http://localhost:4173/auth/callback`
   - Prod: `https://your-host/auth/callback`
5. Once created, capture:
   - **Application (client) ID** → `AZURE_AD_CLIENT_ID`
   - **Directory (tenant) ID** → `AZURE_AD_TENANT_ID`
6. **Certificates & secrets** → new client secret. Capture the value
   → `AZURE_AD_CLIENT_SECRET`. (Use a certificate in prod if your org
   policy requires it; the MSAL config supports both.)
7. **API permissions** → Microsoft Graph → Delegated: `openid`, `profile`,
   `email`, `User.Read`. Grant admin consent if required.
8. **Token configuration** (optional): add the `email` optional claim so
   `account.username` reliably contains the user's email.

## Env vars

Set all five and `AUTH_PROVIDER=microsoft` to enable SSO. Missing any of
them keeps SSO disabled and the app runs in actor-input mode.

```
AUTH_PROVIDER=microsoft
AZURE_AD_TENANT_ID=<tenant guid or "common">
AZURE_AD_CLIENT_ID=<app guid>
AZURE_AD_CLIENT_SECRET=<secret>
AUTH_REDIRECT_URI=http://localhost:4173/auth/callback
AUTH_SESSION_SECRET=<32+ random bytes, hex>
```

Generate a strong session secret:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Auth flow

```
  Browser            App                 Microsoft Entra
    |                  |                       |
    | GET /auth/login  |                       |
    |----------------> |                       |
    |                  | getAuthCodeUrl(state) |
    |                  |---------------------> |
    |                  | <---------------------|
    |                  | redirect to MSFT      |
    | <----------------|                       |
    | user signs in    |                       |
    | ---------------------------------------> |
    |                  | GET /auth/callback?code=...&state=...
    | <-------------------------------------- |
    |                  | acquireTokenByCode    |
    |                  |---------------------> |
    |                  | <---------------------|
    |                  | session.user = claims |
    | redirect to next |                       |
    | <----------------|                       |
```

## Test plan

1. **Disabled mode (`AUTH_PROVIDER` unset).**
   - `npm start`.
   - `GET /auth/me` → `{enabled: false, user: null}`.
   - Appbar shows the actor text input.
   - API calls work without a session.

2. **Enabled mode, stubs in place.**
   - Set all five env vars, `AUTH_PROVIDER=microsoft`.
   - `GET /auth/me` → `{enabled: true, user: null}`.
   - Appbar shows "Sign in with Microsoft".
   - API calls return `401 {code: "AUTH_REQUIRED", login_url: "/auth/login"}`.
   - `GET /auth/login` → `501 {code: "AUTH_NOT_IMPLEMENTED", fn: "getAuthCodeUrl"}`.
     This is the expected stub error.

3. **Enabled mode, stubs filled in.**
   - `GET /auth/login` redirects to `login.microsoftonline.com/...`.
   - After Microsoft sign-in, `GET /auth/callback?code=...` finishes the
     exchange, populates `session.user`, redirects to the original page.
   - `GET /auth/me` → `{enabled: true, user: {oid, name, email, ...}}`.
   - Appbar shows "Signed in as <name> · Sign out".
   - Posting a decision via `/api/decision` writes the user's email into
     the override `actor` field and `actor_oid` Entra GUID.
   - `POST /auth/logout` clears the session.

4. **Session expiry.** Default is 8 hours. After expiry, API returns 401
   and the SPA redirects to login transparently.

## Production hardening checklist

The scaffolding is suitable for internal-use rollout but the engineer
finishing the work should also confirm:

- [ ] **Session store.** `express-session` defaults to in-memory which
  doesn't survive restarts and doesn't work behind multiple replicas. For
  production: swap to Redis (`connect-redis`) or another shared store.
- [ ] **`secure: true` cookies.** Already conditional on
  `NODE_ENV=production` — confirm prod sets that env var.
- [ ] **`AUTH_SESSION_SECRET` rotation.** The dev fallback generates one
  per restart, which logs everyone out on each restart. Prod must set it
  explicitly.
- [ ] **CSRF on `POST /auth/logout`.** Currently unguarded; add a CSRF
  token if the app is reachable from third-party origins.
- [ ] **Group / role claims.** If the org wants to restrict access to a
  specific Entra group, pull `groups` into the token (App registration →
  Token configuration → add groups claim) and gate `requireAuth` on it.
  The `currentUser(req)` helper is the place to enforce.
- [ ] **Logout from Microsoft.** Currently `/auth/logout` clears the
  local session only. To also sign the user out of Microsoft, redirect
  to `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/logout?post_logout_redirect_uri=...`.

## Files to know

| Path | Purpose |
|---|---|
| `lib/auth.js` | **Your file.** Two MSAL stubs to fill in. |
| `server.js` | Session middleware, route gate, decision endpoint that records the SSO identity. |
| `.env.example` | Five required env vars (auth section). |
| `public/index.html` + `public/app.js` | Appbar swap between actor input and SSO widget. |
| `data/decisions.jsonl` | Audit log; new entries carry `actor` (email) and `actor_oid` (stable Entra ID). |

Once both stubs are implemented, no other code changes are required.
