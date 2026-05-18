// Daedalus Backlog Scrub — local management review server.
// All state lives on disk under data/. Nothing writes back to Jira.

const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 4173;
const DATA_DIR = path.join(__dirname, "data");
const SEED_FILE = path.join(DATA_DIR, "seed.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const DECISIONS_FILE = path.join(DATA_DIR, "decisions.jsonl");

const ALLOWED_VERDICTS = ["KEEP", "STOP", "FOLD", "FLAG"];

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function ensureState() {
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ overrides: {} }, null, 2));
  }
}

function loadSeed() {
  if (!fs.existsSync(SEED_FILE)) {
    throw new Error("data/seed.json missing — run `npm run seed`.");
  }
  return loadJson(SEED_FILE, { bus: [] });
}

function loadState() { ensureState(); return loadJson(STATE_FILE, { overrides: {} }); }
function saveState(state) { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

function applyOverrides(seed, state) {
  const overrides = state.overrides || {};
  const out = JSON.parse(JSON.stringify(seed));
  for (const bu of out.bus) {
    for (const project of bu.projects) {
      for (const item of project.items) {
        const ov = overrides[item.key];
        if (ov) {
          item.override = {
            verdict: ov.verdict,
            reason: ov.reason || "",
            actor: ov.actor || "",
            decided_at: ov.decided_at
          };
          item.current_verdict = ov.verdict;
        } else {
          item.current_verdict = item.ai_verdict;
        }
      }
    }
  }
  return out;
}

function tallyBu(bu) {
  const t = { KEEP: 0, STOP: 0, FOLD: 0, FLAG: 0, total: 0, overrides: 0 };
  for (const project of bu.projects) {
    for (const item of project.items) {
      t[item.current_verdict] = (t[item.current_verdict] || 0) + 1;
      t.total++;
      if (item.override) t.overrides++;
    }
  }
  return t;
}

function appendDecision(rec) {
  fs.appendFileSync(DECISIONS_FILE, JSON.stringify(rec) + "\n");
}

function readDecisionsFor(key) {
  if (!fs.existsSync(DECISIONS_FILE)) return [];
  return fs.readFileSync(DECISIONS_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .filter(d => !key || d.key === key);
}

// ---- App ----
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get("/api/bus", (_req, res) => {
  const seed = loadSeed();
  const state = loadState();
  const decorated = applyOverrides(seed, state);
  res.json({
    generated_at: seed.generated_at,
    bus: decorated.bus.map(bu => ({
      slug: bu.slug,
      name: bu.name,
      project_count: bu.project_count,
      item_count: bu.item_count,
      scrubbed_date: bu.scrubbed_date,
      tally: tallyBu(bu)
    }))
  });
});

app.get("/api/bu/:slug", (req, res) => {
  const seed = loadSeed();
  const state = loadState();
  const decorated = applyOverrides(seed, state);
  const bu = decorated.bus.find(b => b.slug === req.params.slug);
  if (!bu) return res.status(404).json({ error: "BU not found" });
  bu.tally = tallyBu(bu);
  res.json(bu);
});

app.get("/api/item/:key", (req, res) => {
  const seed = loadSeed();
  const state = loadState();
  const decorated = applyOverrides(seed, state);
  for (const bu of decorated.bus) {
    for (const project of bu.projects) {
      const item = project.items.find(i => i.key === req.params.key);
      if (item) {
        return res.json({
          item,
          bu: { slug: bu.slug, name: bu.name },
          project: { key: project.key, name: project.name, category: project.category },
          history: readDecisionsFor(item.key)
        });
      }
    }
  }
  res.status(404).json({ error: "Item not found" });
});

app.post("/api/decision", (req, res) => {
  const { key, verdict, reason, actor } = req.body || {};
  if (!key) return res.status(400).json({ error: "key required" });
  if (!ALLOWED_VERDICTS.includes(verdict)) {
    return res.status(400).json({ error: `verdict must be one of ${ALLOWED_VERDICTS.join(", ")}` });
  }
  // Confirm the item exists in seed
  const seed = loadSeed();
  let found = null;
  for (const bu of seed.bus) for (const p of bu.projects) {
    const it = p.items.find(i => i.key === key);
    if (it) { found = { item: it, bu, project: p }; break; }
    if (found) break;
  }
  if (!found) return res.status(404).json({ error: "item not found in seed" });

  const state = loadState();
  const prev = state.overrides[key] || null;
  const decided_at = new Date().toISOString();
  const next = {
    verdict,
    reason: reason || "",
    actor: actor || "anonymous",
    decided_at
  };
  state.overrides[key] = next;
  saveState(state);

  appendDecision({
    key,
    bu_slug: found.bu.slug,
    project_key: found.project.key,
    ai_verdict: found.item.ai_verdict,
    previous_verdict: prev ? prev.verdict : null,
    new_verdict: verdict,
    reason: reason || "",
    actor: actor || "anonymous",
    decided_at
  });

  res.json({ ok: true, override: next });
});

app.delete("/api/decision/:key", (req, res) => {
  const state = loadState();
  const prev = state.overrides[req.params.key];
  if (!prev) return res.json({ ok: true, cleared: false });
  delete state.overrides[req.params.key];
  saveState(state);
  appendDecision({
    key: req.params.key,
    action: "clear_override",
    previous_verdict: prev.verdict,
    decided_at: new Date().toISOString(),
    actor: (req.body && req.body.actor) || "anonymous"
  });
  res.json({ ok: true, cleared: true });
});

app.get("/api/decisions", (req, res) => {
  res.json({ decisions: readDecisionsFor(req.query.key) });
});

// Refresh hooks — today they just re-read the seed file. Wire to Jira later
// by replacing the body of these handlers to call Jira and rewrite seed.json
// for the affected scope, then return the new tally.
app.post("/api/refresh", (_req, res) => {
  const seed = loadSeed();
  res.json({
    ok: true,
    refreshed_at: new Date().toISOString(),
    generated_at: seed.generated_at,
    note: "Stub refresh — re-reads data/seed.json. Wire Jira pull here when ready."
  });
});

app.post("/api/refresh/bu/:slug", (req, res) => {
  const seed = loadSeed();
  const bu = seed.bus.find(b => b.slug === req.params.slug);
  if (!bu) return res.status(404).json({ error: "BU not found" });
  res.json({
    ok: true,
    bu: bu.slug,
    refreshed_at: new Date().toISOString(),
    item_count: bu.item_count,
    note: "Stub refresh — wire per-BU Jira pull here."
  });
});

app.post("/api/refresh/project/:key", (req, res) => {
  const seed = loadSeed();
  for (const bu of seed.bus) {
    const p = bu.projects.find(p => p.key === req.params.key);
    if (p) return res.json({
      ok: true,
      project: p.key,
      bu: bu.slug,
      refreshed_at: new Date().toISOString(),
      item_count: p.item_count,
      note: "Stub refresh — wire per-project Jira pull here."
    });
  }
  res.status(404).json({ error: "Project not found" });
});

app.listen(PORT, () => {
  console.log(`Daedalus scrub running on http://localhost:${PORT}`);
});
