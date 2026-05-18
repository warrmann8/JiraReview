# Daedalus Backlog Scrub — Management Review Console

Local app for walking every meaningful Jira item across the 17 AFI business units,
overriding the AI-generated verdict (KEEP / STOP / FOLD / FLAG), and logging every
decision to an append-only audit log. Nothing here writes back to Jira.

## Running

```
npm install
cp .env.example .env   # then fill in your provider keys
npm run seed           # rebuilds data/seed.json from the source scrub HTMLs
npm start              # serves on http://localhost:4173
```

## LLM scorer

The "Add items…" button on each BU page lets you ingest new Jira Epics (one
at a time via a form, or bulk via a pasted JSON array). Each Epic is scored
by an LLM using the framework in `prompts/item-review.md` — the system prompt
walks the gates and returns a verdict (KEEP / STOP / FOLD / FLAG) plus
structured metadata (gate, confidence, rationale, harvest target,
dependencies, questions for human).

**Scope: Epic-level only.** Stories, Tasks, Sub-tasks, and Bugs are not
scored — they roll up under their parent Epic as evidence. The server
rejects non-Epic types (Initiative is accepted as an Epic-equivalent).

Two providers are wired up; pick one in `.env`:

| Provider | Set                                                                                 |
|----------|-------------------------------------------------------------------------------------|
| Azure OpenAI (default) | `SCORER_PROVIDER=azure`, `AZURE_OPENAI_ENDPOINT=...`, `AZURE_OPENAI_API_KEY=...`, `AZURE_OPENAI_DEPLOYMENT=...` |
| Anthropic | `SCORER_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=...`, `ANTHROPIC_MODEL=claude-opus-4-7` |

### Token-cost optimizations

- **Trimmed system prompt** — the canonical Daedalus item-review spec was
  ~33KB / ~8,500 tokens. The version in `prompts/item-review.md` strips the
  worked examples and meta-instructions while preserving every gate, hard
  rule, BU-context field, and the full output-schema field reference.
  Now ~14KB / ~3,500 tokens — roughly 60% cheaper per call.
- **Lite mode for bulk** — single-item ingests return the full Section 7
  schema (rationale, dependencies, questions for human). Bulk ingests return
  only `verdict / gate / reason / harvest_target` (about 60% fewer output
  tokens). The decision modal renders gracefully for both shapes.
- **Anthropic prompt caching** — the system prompt is sent with
  `cache_control: ephemeral` so re-scoring 50 Epics in one session pays for
  the system tokens once at ~1.25× and the rest at ~0.1×.

Only newly ingested items are scored — existing items (the 1,318 seeded
from the two HTML scrubs) keep their original verdicts. The AI metadata for
each scored item appears in the decision modal alongside the human override
controls.

Open `http://localhost:4173`. Pick a BU. Walk items. Use the per-row buttons to
set a verdict (KEEP / FOLD / FLAG / STOP — labeled "Kill" on the action row).
A modal opens to capture the reason and writes a record.

## Data

- `data/seed.json` — read-only seed produced by `scripts/seed.js`. Regenerate
  after dropping new scrub HTMLs into the uploads folder.
- `data/state.json` — current overrides keyed by item key. The "current verdict"
  the UI shows is the override if present, otherwise the AI verdict.
- `data/decisions.jsonl` — append-only audit log. One JSON record per decision
  (set or clear), with previous verdict, new verdict, reason, actor, timestamp.

## Adding more BUs

Two BUs (AFI Data & Analytics and AFI Supply Chain) come pre-loaded from the
two example scrub HTMLs. The other 15 BUs are present as empty shells.

To add another BU's scrub:
1. Extend `scripts/seed.js` with a parser for the new HTML's data shape, or
   normalize your scrub into the existing item schema and emit it directly.
2. Re-run `npm run seed`.
3. Refresh the browser — the BU tile populates.

## Jira integration

Refresh endpoints are wired through `lib/jira.js`. Five small stubs need
to be filled in to enable live Jira pulls — see **`JIRA-HANDOFF.md`** for
the engineer doing that work. Until they're implemented:

- The app runs fully against `data/seed.json` (offline / seed-only mode).
- `GET /api/jira/status` returns `{configured: false}` when env vars are missing.
- The refresh buttons return a `note: "Jira not configured"` rather than crashing.

Required env vars (see `.env.example`):

```
JIRA_BASE_URL=https://ashley-furniture-team.atlassian.net
JIRA_EMAIL=<service account email>
JIRA_API_TOKEN=<token from id.atlassian.com>
```

Refresh endpoints:

- `POST /api/refresh` — global refresh
- `POST /api/refresh/bu/:slug` — single BU
- `POST /api/refresh/project/:key` — single project (fully implemented end-to-end once `searchEpics` is live)
- `GET  /api/jira/status` — auth round-trip check

## API surface

- `GET  /api/bus` — all BUs with verdict tallies
- `GET  /api/bu/:slug` — one BU, full projects + items, overrides applied
- `GET  /api/bu/:slug/export.html` — self-contained HTML report for the BU
- `GET  /api/bu/:slug/initiatives` — distinct parent Initiatives in a BU
- `GET  /api/item/:key` — one item plus its full decision history
- `POST /api/decision` — body `{ key, verdict, reason, actor }`
- `DELETE /api/decision/:key` — clear override
- `GET  /api/decisions?key=...` — full audit log (filter by key optional)
- `GET  /api/activity?days=N&mine=1` — rolled-up decisions over a window
- `GET  /api/prompt`, `PUT /api/prompt`, `GET /api/prompt/history` — AI rules
- `POST /api/score`, `POST /api/ingest/project/:key/{single,bulk}` — LLM scorer
- `GET  /api/jira/status`, `POST /api/refresh{,/bu/:slug,/project/:key}` — Jira
- `GET  /auth/me`, `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` — SSO

## Keyboard shortcuts

- `Cmd/Ctrl+K` — open the global Epic search palette
- `/` — focus the BU search box (when in a BU)
- In the decision modal: `K`/`S`/`F`/`L` to pick a verdict, `Cmd+Enter` to save, `Esc` to close
- `Shift-click` a row verdict button to save without opening the modal

## Tests

`npm test` runs the node:test suite covering the scorer gating, the Jira
field mapping + ADF flattening, and the auth middleware semantics. Network
calls are not exercised — those are the stubs the engineer fills in per
JIRA-HANDOFF.md and AUTH-HANDOFF.md.
