// Daedalus Backlog Scrub — local management review server.
// All state lives on disk under data/. Nothing writes back to Jira.

require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const fs = require("fs");
const path = require("path");
const { scoreItem, getProvider, isEpicLevel, EPIC_LEVEL_TYPES } = require("./lib/scorer");
const jira = require("./lib/jira");

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

// ---- Jira integration ----
//
// Refresh endpoints call into lib/jira.js. Until that module's stubs are
// filled in, refresh returns a 501 with structured guidance pointing the
// implementer at JIRA-HANDOFF.md.
//
// Once jira.js is implemented, the handlers below pull Epics for the
// requested scope, persist them via persistScoredItem (no LLM rescore;
// existing items keep their verdicts; new items get scored on the next
// /api/ingest call), and return the refreshed tally.

function jiraErrorResponse(res, e) {
  if (e && e.code === "JIRA_NOT_CONFIGURED") {
    return res.status(501).json({
      error: e.message,
      code: e.code,
      missing: e.missing,
      handoff: "See JIRA-HANDOFF.md — set the env vars and restart."
    });
  }
  if (e && e.code === "JIRA_NOT_IMPLEMENTED") {
    return res.status(501).json({
      error: e.message,
      code: e.code,
      fn: e.fn,
      handoff: "See JIRA-HANDOFF.md — implement the marked TODO in lib/jira.js."
    });
  }
  return res.status(502).json({ error: String((e && e.message) || e) });
}

app.get("/api/jira/status", async (_req, res) => {
  const configured = jira.isConfigured();
  if (!configured) {
    return res.json({
      configured: false,
      required_env: jira.REQUIRED_ENV,
      handoff: "See JIRA-HANDOFF.md."
    });
  }
  try {
    const ping = await jira.ping();
    res.json({ configured: true, ping });
  } catch (e) {
    res.json({
      configured: true,
      ping_ok: false,
      error: e.message,
      code: e.code || null,
      handoff: e.code === "JIRA_NOT_IMPLEMENTED" ? "Stubs still in place — see JIRA-HANDOFF.md." : undefined
    });
  }
});

app.post("/api/refresh", async (_req, res) => {
  // TODO post-Jira-wireup: iterate every populated project and call refreshProject.
  // For now we still answer success on the stubbed path so the UI's "Refresh all"
  // button doesn't appear broken before Jira is wired.
  if (!jira.isConfigured()) {
    const seed = loadSeed();
    return res.json({
      ok: true,
      refreshed_at: new Date().toISOString(),
      generated_at: seed.generated_at,
      note: "Jira not configured — see JIRA-HANDOFF.md. Returning current seed."
    });
  }
  try {
    await jira.ping();
    res.json({ ok: true, refreshed_at: new Date().toISOString(), note: "Per-project refresh not yet looped; call /api/refresh/project/:key per project." });
  } catch (e) {
    jiraErrorResponse(res, e);
  }
});

app.post("/api/refresh/bu/:slug", async (req, res) => {
  const seed = loadSeed();
  const bu = seed.bus.find(b => b.slug === req.params.slug);
  if (!bu) return res.status(404).json({ error: "BU not found" });
  if (!jira.isConfigured()) {
    return res.json({
      ok: true,
      bu: bu.slug,
      refreshed_at: new Date().toISOString(),
      item_count: bu.item_count,
      note: "Jira not configured — see JIRA-HANDOFF.md."
    });
  }
  // TODO post-wireup: for each project in bu.projects, call refreshProjectInternal.
  try {
    await jira.ping();
    res.json({ ok: true, bu: bu.slug, note: "Per-BU loop pending — implement once searchEpics is live." });
  } catch (e) {
    jiraErrorResponse(res, e);
  }
});

app.post("/api/refresh/project/:key", async (req, res) => {
  const projectKey = req.params.key;
  const seed = loadSeed();
  const loc = findProject(seed, projectKey);
  if (!loc) return res.status(404).json({ error: "Project not found" });

  if (!jira.isConfigured()) {
    return res.json({
      ok: true,
      project: loc.project.key,
      bu: loc.bu.slug,
      refreshed_at: new Date().toISOString(),
      item_count: loc.project.item_count,
      note: "Jira not configured — see JIRA-HANDOFF.md."
    });
  }

  try {
    // Pull Epics + Initiatives. Initiative-type results are stored as
    // top-level entries; their key becomes the parent_key target for Epics.
    const incoming = await jira.searchEpics(projectKey, { includeInitiatives: true, limit: 500 });

    // Merge: existing items keep their AI verdicts; new ones land
    // unscored (verdict "FLAG" until the next ingest pass).
    const existingByKey = new Map(loc.project.items.map(i => [i.key, i]));
    const merged = incoming.map(raw => {
      const prior = existingByKey.get(raw.key);
      if (prior) {
        // Keep prior verdict + ai_meta, refresh field values from Jira.
        return { ...prior, ...raw, project_key: loc.project.key, bu_slug: loc.bu.slug, source_file: "jira" };
      }
      return {
        ...raw,
        project_key: loc.project.key,
        bu_slug: loc.bu.slug,
        source_file: "jira",
        ai_verdict: "FLAG",
        ai_gate: null,
        ai_reason: "FLAG — Newly pulled from Jira; not yet scored. Run an ingest to walk the gates.",
        child_evidence: "",
        ai_meta: null
      };
    });

    loc.project.items = merged;
    loc.project.item_count = merged.length;
    loc.bu.item_count = loc.bu.projects.reduce((n, p) => n + p.items.length, 0);
    fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));

    res.json({
      ok: true,
      project: loc.project.key,
      bu: loc.bu.slug,
      refreshed_at: new Date().toISOString(),
      item_count: merged.length,
      pulled: incoming.length
    });
  } catch (e) {
    jiraErrorResponse(res, e);
  }
});

// ---- Scoring + ingest ----

function findProject(seed, projectKey) {
  for (const bu of seed.bus) {
    const p = bu.projects.find(p => p.key === projectKey);
    if (p) return { bu, project: p };
  }
  return null;
}

function buContextFor(bu) {
  // Caller-provided context block per Section 8 of the prompt. Minimal default
  // built from the seeded BU metadata; richer overrides can come from the request.
  return {
    bu_name: bu.name,
    wave_unit: null,
    wave_status: "deferred",
    consolidation_flag: false,
    executive_flags: [],
    default_posture: "Maintain at run-rate; freeze net-new pending wave assignment",
    discovery_default: "STOP unless tied to a wave unit"
  };
}

function normalizeIncoming(raw, projectKey, buSlug) {
  // Accepts a loose Jira-like shape and produces our internal item record.
  const key = raw.key || raw.id;
  if (!key) throw new Error("Each item must have a key.");
  return {
    key,
    summary: raw.summary || raw.title || "",
    project_key: projectKey,
    bu_slug: buSlug,
    type: raw.type || raw.issue_type || "Story",
    status: raw.status || "",
    priority: raw.priority || "",
    parent_key: raw.parent_key || raw.parent || "",
    parent_summary: raw.parent_summary || "",
    url: raw.url || `https://ashley-furniture-team.atlassian.net/browse/${encodeURIComponent(key)}`,
    description: raw.description || "",
    labels: Array.isArray(raw.labels) ? raw.labels : [],
    assignee: raw.assignee || "",
    updated: raw.updated || "",
    source_file: "ingested"
  };
}

function persistScoredItem(item, scored) {
  const seed = loadSeed();
  const loc = findProject(seed, item.project_key);
  if (!loc) throw new Error(`Project ${item.project_key} not in roster.`);
  // Skip if already present — "score only newly ingested items" rule.
  const existing = loc.project.items.find(i => i.key === item.key);
  if (existing) {
    return { skipped: true, reason: "already scored", key: item.key };
  }
  const isLite = scored._meta && scored._meta.mode === "lite";
  const stored = {
    ...item,
    ai_verdict: scored.verdict,
    ai_gate: scored.gate,
    ai_reason: scored.reason,
    child_evidence: "",
    ai_meta: isLite
      ? {
          provider: scored._meta.provider,
          model: scored._meta.model,
          mode: "lite",
          scored_at: scored._meta.scored_at,
          harvest: scored.verdict === "FOLD"
            ? { applies: true, target: scored.harvest_target || "", note: "" }
            : { applies: false, target: "", note: "" },
          usage: scored._meta.usage,
          latency_ms: scored._meta.latency_ms
        }
      : {
          provider: scored._meta.provider,
          model: scored._meta.model,
          mode: "full",
          scored_at: scored._meta.scored_at,
          confidence: scored.confidence,
          tentative_verdict: scored.tentative_verdict,
          rationale: scored.rationale,
          dependencies: scored.dependencies,
          needs_to_resolve: scored.needs_to_resolve,
          questions_for_human: scored.questions_for_human,
          harvest: scored.harvest,
          effort_estimate: scored.effort_estimate,
          staleness_days: scored.staleness_days,
          notes: scored.notes,
          usage: scored._meta.usage,
          latency_ms: scored._meta.latency_ms
        }
  };
  loc.project.items.push(stored);
  loc.project.item_count = loc.project.items.length;
  loc.bu.item_count = loc.bu.projects.reduce((n, p) => n + p.items.length, 0);
  fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));
  return { skipped: false, key: item.key, stored };
}

// Distinct Initiatives observed in a BU's items. Used by the filter UI.
app.get("/api/bu/:slug/initiatives", (req, res) => {
  const seed = loadSeed();
  const bu = seed.bus.find(b => b.slug === req.params.slug);
  if (!bu) return res.status(404).json({ error: "BU not found" });
  const byKey = new Map();
  for (const project of bu.projects) {
    for (const item of project.items) {
      const k = item.parent_key || "";
      if (!byKey.has(k)) {
        byKey.set(k, { key: k, summary: item.parent_summary || "", count: 0 });
      }
      byKey.get(k).count += 1;
    }
  }
  const initiatives = Array.from(byKey.values()).sort((a, b) => {
    if (!a.key && b.key) return 1;
    if (a.key && !b.key) return -1;
    return b.count - a.count;
  });
  res.json({ bu: bu.slug, initiatives });
});

app.get("/api/scorer/info", (_req, res) => {
  try {
    res.json({
      provider: getProvider(),
      model: process.env.SCORER_PROVIDER === "azure"
        ? process.env.AZURE_OPENAI_DEPLOYMENT
        : (process.env.ANTHROPIC_MODEL || "claude-opus-4-7"),
      configured: true
    });
  } catch (e) {
    res.json({ provider: null, configured: false, error: e.message });
  }
});

// Score a single ad-hoc item without persisting (preview).
app.post("/api/score", async (req, res) => {
  const { item, bu_context, mode } = req.body || {};
  if (!item || !item.key) return res.status(400).json({ error: "item.key required" });
  if (!isEpicLevel(item.type)) {
    return res.status(400).json({
      error: `Scoring is Epic-level only. Item type was "${item.type || "<unset>"}". Allowed: ${EPIC_LEVEL_TYPES.join(", ")}.`
    });
  }
  try {
    const scored = await scoreItem(item, bu_context, { mode });
    res.json({ ok: true, scored });
  } catch (e) {
    res.status(e.code === "NOT_EPIC_LEVEL" ? 400 : 500).json({ error: String(e.message || e) });
  }
});

// Ingest one item into a project: score it, persist if new. Uses full schema.
app.post("/api/ingest/project/:key/single", async (req, res) => {
  const projectKey = req.params.key;
  const { item: raw, bu_context } = req.body || {};
  if (!raw) return res.status(400).json({ error: "item required" });
  if (!isEpicLevel(raw.type)) {
    return res.status(400).json({
      error: `Scoring is Epic-level only. Item type was "${raw.type || "<unset>"}". Allowed: ${EPIC_LEVEL_TYPES.join(", ")}.`
    });
  }
  if (String(raw.type).toLowerCase() === "epic" && !raw.parent_key) {
    return res.status(400).json({
      error: `Epic ${raw.key || ""} needs a parent Initiative. Set parent_key (and parent_summary).`
    });
  }
  const seed = loadSeed();
  const loc = findProject(seed, projectKey);
  if (!loc) return res.status(404).json({ error: "project not found" });
  try {
    const item = normalizeIncoming(raw, projectKey, loc.bu.slug);
    const ctx = bu_context || buContextFor(loc.bu);
    const scored = await scoreItem(item, ctx, { mode: "full" });
    const persisted = persistScoredItem(item, scored);
    res.json({ ok: true, scored, persisted });
  } catch (e) {
    res.status(e.code === "NOT_EPIC_LEVEL" ? 400 : 500).json({ error: String(e.message || e) });
  }
});

// Bulk ingest into a project. Uses lite schema by default (~60% fewer output
// tokens). Non-Epic items are rejected per-row, not for the whole batch.
app.post("/api/ingest/project/:key/bulk", async (req, res) => {
  const projectKey = req.params.key;
  const { items, bu_context, mode } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items[] required" });
  }
  if (items.length > 200) {
    return res.status(400).json({ error: "max 200 items per bulk call" });
  }
  const useMode = mode === "full" ? "full" : "lite";
  const seed = loadSeed();
  const loc = findProject(seed, projectKey);
  if (!loc) return res.status(404).json({ error: "project not found" });
  const ctx = bu_context || buContextFor(loc.bu);

  const results = [];
  for (const raw of items) {
    try {
      if (!isEpicLevel(raw && raw.type)) {
        results.push({
          key: raw && raw.key,
          ok: true,
          skipped: true,
          reason: `not Epic-level (type="${(raw && raw.type) || "<unset>"}")`
        });
        continue;
      }
      if (String(raw.type).toLowerCase() === "epic" && !raw.parent_key) {
        results.push({
          key: raw.key,
          ok: false,
          error: "Epic missing parent_key (must link to a parent Initiative)"
        });
        continue;
      }
      const item = normalizeIncoming(raw, projectKey, loc.bu.slug);
      const seedNow = loadSeed();
      const locNow = findProject(seedNow, projectKey);
      if (locNow.project.items.find(i => i.key === item.key)) {
        results.push({ key: item.key, ok: true, skipped: true, reason: "already scored" });
        continue;
      }
      const scored = await scoreItem(item, ctx, { mode: useMode });
      const persisted = persistScoredItem(item, scored);
      results.push({ key: item.key, ok: true, verdict: scored.verdict, persisted });
    } catch (e) {
      results.push({ key: raw && raw.key, ok: false, error: String(e.message || e) });
    }
  }
  res.json({ ok: true, results, mode: useMode });
});

app.listen(PORT, () => {
  console.log(`Daedalus scrub running on http://localhost:${PORT}`);
  try {
    const p = getProvider();
    console.log(`Scorer provider: ${p}`);
  } catch {
    console.log("Scorer provider: not configured (set SCORER_PROVIDER + creds in .env)");
  }
});
