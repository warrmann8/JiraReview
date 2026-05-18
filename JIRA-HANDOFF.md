# Jira Integration — Handoff

**Audience:** the engineer who will wire up the actual Jira API calls.
**Status:** all integration points are stubbed and labeled. The rest of the
app (UI, scorer, decision logging, ingest) is feature-complete and tested
against the seed data. You will not need to touch anything except
`lib/jira.js` and a couple of small wiring spots in `server.js` if you want
to change the merge policy.

## What the app does

A local Node + Express management-review tool. Reviewers walk every Jira
Epic across the 17 AFI business units, see an LLM-generated verdict
(KEEP / STOP / FOLD / FLAG) per Epic, and override or "kill" any of them
with a logged reason. The app currently runs entirely off
`data/seed.json`, which was built from the two example scrub HTMLs. Your
job is to replace that seed pipeline with live Jira pulls.

The scrub framework (gates, rules, output schema) is in
`prompts/item-review.md`. The roster of 17 BUs / 91 projects is in
`scripts/roster.js`. Both are read-only for your purposes.

## What you need to wire up

Exactly one file: **`lib/jira.js`**. Five stub functions (each one throws
`JiraNotImplementedError` today with the exact body it needs to have):

| Function | What it does | Maps to |
|---|---|---|
| `ping()` | Round-trip auth check. | `GET /rest/api/3/myself` |
| `searchEpics(projectKey, opts)` | Paginated JQL search; returns normalized items. | `POST /rest/api/3/search/jql` |
| `getEpic(key)` | Single-issue fetch. | `GET /rest/api/3/issue/{key}` |
| `getInitiative(key)` | Same call as getEpic, with type assertion. | `GET /rest/api/3/issue/{key}` |
| `normalizeIssue(issue)` | **Already implemented.** Maps a Jira issue payload to the app's internal item shape. | — |

Every function has a TODO block immediately below it with the recipe.
`normalizeIssue` and `flattenAdf` (ADF document → plain text) are both
finished — don't rewrite them.

## Credentials

The cheapest auth path is Atlassian Cloud's API token over Basic auth:

1. Sign in as a service account that has read access to all projects in
   `scripts/roster.js`.
2. Generate an API token at
   https://id.atlassian.com/manage-profile/security/api-tokens.
3. Set three env vars (already documented in `.env.example`):

```
JIRA_BASE_URL=https://ashley-furniture-team.atlassian.net
JIRA_EMAIL=jirareview-svc@ashley.com   # the account that owns the token
JIRA_API_TOKEN=<the token>
```

The request header is then:

```
Authorization: Basic ${base64(`${email}:${token}`)}
Accept: application/json
```

OAuth 2.0 (3LO) is also fine if your org policy requires it — swap the
auth header for `Authorization: Bearer <access_token>` and add a token
refresh path. Nothing else changes.

## Internal item shape

`normalizeIssue(issue)` returns this shape — it must match the items that
`scripts/seed.js` already writes to `data/seed.json`:

```js
{
  key:            "DSI-372",
  summary:        "Streamline Server Implementation as Backup",
  type:           "Epic" | "Initiative" | "Story" | ...,
  status:         "In Progress" | "Backlog" | ...,
  priority:       "High" | "Medium" | ...,
  parent_key:     "AFIINIT-31",        // the Initiative the Epic links to
  parent_summary: "Next-Gen Supply Chain Planning Transformation",
  url:            "https://ashley-furniture-team.atlassian.net/browse/DSI-372",
  description:    "<plain text flattened from ADF>",
  labels:         ["ROADMAP", "SFCC"],
  assignee:       "Jane Doe",
  updated:        "2026-04-22T14:05:00.000Z"
}
```

The Initiative linkage (`parent_key` + `parent_summary`) is **required**
on every Epic — the app enforces this at ingest. If a customer Jira
instance uses a custom field for Initiative linkage instead of the native
`parent` field, ask the Jira admin which `customfield_*` ID holds it
and adjust `normalizeIssue` accordingly. Today the code reads
`issue.fields.parent` (Atlassian's "next-gen parent" field, which works on
team-managed and company-managed projects in Cloud).

## JQL the app actually uses

From `prompts/item-review.md` Section 2 of the original spec, plus the
Epic-only constraint:

```
# Active Epics for a project
project = "DSI" AND issuetype = Epic AND statusCategory = "In Progress" ORDER BY updated DESC

# Open backlog Epics
project = "DSI" AND issuetype = Epic AND statusCategory = "To Do" ORDER BY priority DESC, created DESC

# Anything touched recently (regardless of category)
project = "DSI" AND issuetype = Epic AND updated >= -14d ORDER BY updated DESC

# Discovery projects — pull Ideas not Epics
project = "SCD" AND issuetype in (Idea, Discovery)
```

`searchEpics` builds these from the `options` argument. Look at the
parameter docstring for the exact mapping.

## Pagination & rate limits

- **Search endpoint pagination:** Atlassian Cloud's v3 search uses
  `nextPageToken`, not `startAt`. POST to `/rest/api/3/search/jql` with
  `{ jql, fields, maxResults: 100, nextPageToken }`. Stop when the
  response omits `nextPageToken`.
- **Rate limits:** roughly 10 req/s on search, with per-org caps that
  vary. On `429`, honor the `Retry-After` header; on `503`, retry once
  with backoff. Don't add a custom retry library — a small exponential
  backoff in the function body is fine.

## How the rest of the app talks to your module

There are exactly two callers:

1. **`server.js` refresh endpoints** — already wired to call `jira.ping`
   and `jira.searchEpics`. They fall through to a "Jira not configured"
   response if the env vars are missing, so partial setups don't crash.
   - `POST /api/refresh/project/:key` is fully implemented end-to-end
     (modulo your function bodies): it calls `searchEpics`, merges with
     existing scored items (existing items keep their AI verdicts), and
     persists.
   - `POST /api/refresh/bu/:slug` and `POST /api/refresh` are scoped
     placeholders. Once `searchEpics` works, loop over the BU's projects
     and call the per-project path.

2. **`scripts/seed.js`** — currently builds `data/seed.json` from the
   uploaded scrub HTMLs. Optional: extend it to seed from Jira directly
   for any BU that hasn't shipped a scrub HTML yet. Not required.

## Merge / refresh policy

When `/api/refresh/project/:key` runs:

- **Existing items** (matched by `key`): keep their `ai_verdict`,
  `ai_gate`, `ai_reason`, `ai_meta`, and any human override. Refresh the
  Jira-side fields (summary, status, priority, parent, updated, labels,
  description, assignee) so the table stays accurate.
- **New items** (not in seed.json): land with `ai_verdict: "FLAG"` and a
  reason explaining they're newly pulled and unscored. A reviewer can
  then run the scorer on them via the ingest path, or you can wire
  auto-scoring here later.

If you want a different merge policy (e.g., always re-score on refresh,
or re-score only when the description hash changes), the merge logic is
in `server.js` inside `app.post("/api/refresh/project/:key", ...)` and is
~20 lines. Easy to change.

## Test plan

1. **Empty env, app boots.** `npm start` should print
   `Scorer provider: ...` (LLM) and serve the UI. Refresh buttons should
   return `{ok: true, note: "Jira not configured — see JIRA-HANDOFF.md"}`.

2. **Env set, ping works.** Hit `GET /api/jira/status`. Expect
   `{configured: true, ping: {...}}` with the service account's
   displayName.

3. **searchEpics on one project.**

   ```sh
   curl -X POST http://localhost:4173/api/refresh/project/DSI
   ```

   Expect `{ok: true, project: "DSI", item_count: N, pulled: N}` and
   `data/seed.json` updated. New items appear in the UI under AFI Supply
   Chain → Demand, Supply & Inventory with a `FLAG` verdict.

4. **Existing items survive.** Pre-existing DSI Epics (15 already seeded
   from the Supply Chain scrub) should keep their KEEP/FOLD/FLAG verdicts
   after the refresh. Their summary/status fields should update if Jira
   has newer values.

5. **Initiative linkage holds.** Every refreshed Epic's `parent_key`
   should resolve to a real Initiative — spot-check three keys via
   `GET /api/item/{key}` and confirm `parent_key` matches Jira.

6. **Rate limit graceful.** Force a 429 (or stub one in a unit test) and
   confirm the function backs off rather than throwing.

## Out of scope for this handoff

- Writing back to Jira (transitioning issues, posting comments,
  recording decisions on the ticket). The app explicitly does not do
  this today; decisions live in `data/decisions.jsonl` only.
- Webhooks / push updates. Refresh is pull-only.
- OAuth-protected SSO setup beyond the basic 3LO swap noted above.
- Persisting credentials beyond environment variables.

## Files to know

| Path | Purpose |
|---|---|
| `lib/jira.js` | **Your file.** Five stubs to fill in. |
| `.env.example` | Required env vars (Jira section). |
| `server.js` | Refresh endpoints already wired to `jira.*` calls; you shouldn't need to edit. |
| `scripts/seed.js` | Builds `data/seed.json` from HTML scrubs; optionally extend to seed from Jira. |
| `prompts/item-review.md` | The LLM scoring framework. Read-only for your purposes. |
| `data/seed.json` | The current snapshot. Refresh writes back to this file. |
| `data/decisions.jsonl` | Append-only human-decision log. Refresh doesn't touch this. |

## Questions worth confirming with the Jira admin before coding

1. Is `issue.fields.parent` populated on Epics with the Initiative they
   link to, or does AFI use a custom `customfield_*` for Initiative
   linkage? If custom, what's the field ID?
2. Are Discovery items (SCD, AID, GD, etc.) issuetype `Idea` or
   `Discovery`, or are they on Jira Product Discovery (JPD) projects with
   a different API? JPD has its own endpoints.
3. Does the service account have read access to all 91 projects in
   `scripts/roster.js`, or will some 404 on first call?
4. Is Basic auth (email + API token) acceptable, or does AFI require
   OAuth 2.0 (3LO)?
5. What rate-limit tier is the org on? Default Cloud is 10 req/s for
   search; some orgs have higher.

Once these are nailed down, the actual implementation is a couple of
hours of work for the four stubs.
