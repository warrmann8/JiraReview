// Daedalus Backlog Scrub — local management review server.
// All state lives on disk under data/. Nothing writes back to Jira.

require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { scoreItem, getProvider, isEpicLevel, EPIC_LEVEL_TYPES } = require("./lib/scorer");
const jira = require("./lib/jira");
const auth = require("./lib/auth");

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

// Session middleware — required by Microsoft SSO when enabled. Loaded
// always so /auth/me works even in disabled mode (returns enabled:false).
let session;
try { session = require("express-session"); }
catch { session = null; }
if (session) {
  app.use(session({
    secret: process.env.AUTH_SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 60 * 60 * 1000 // 8 hours
    }
  }));
}

// Auth routes (/auth/login, /auth/callback, /auth/logout, /auth/me).
auth.mount(app);

// Gate /api and the SPA behind SSO when enabled. requireAuth is a no-op
// when SSO is disabled, so dev / single-user mode still works as before.
app.use((req, res, next) => {
  // Always allow these regardless of auth state.
  if (req.path === "/auth/me" || req.path.startsWith("/auth/")) return next();
  if (req.path === "/styles.css" || req.path === "/app.js" || req.path === "/favicon.ico") return next();
  return auth.requireAuth(req, res, next);
});

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

  // SSO identity wins over client-supplied actor field. Falls back to the
  // textbox when SSO is disabled (dev / single-user mode).
  const ssoUser = auth.currentUser(req);
  const actorIdentity = ssoUser ? (ssoUser.email || ssoUser.name || ssoUser.oid) : (actor || "anonymous");

  const state = loadState();
  const prev = state.overrides[key] || null;
  const decided_at = new Date().toISOString();
  const next = {
    verdict,
    reason: reason || "",
    actor: actorIdentity,
    actor_oid: ssoUser ? ssoUser.oid : null,
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
    actor: actorIdentity,
    actor_oid: ssoUser ? ssoUser.oid : null,
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

// ---- Prompt editor ----
//
// The evaluation rules the LLM uses live in prompts/item-review.md. The
// editor lets reviewers tweak gates/rules/cheatsheet without redeploying.
// Every save snapshots the previous version into prompts/history/ so an
// edit can be rolled back. Save also nudges the scorer to re-read the
// file on the next request (the module currently reads on require, so we
// bust its require-cache).

const PROMPT_FILE = path.join(__dirname, "prompts", "item-review.md");
const PROMPT_HISTORY = path.join(__dirname, "prompts", "history");

app.get("/api/prompt", (_req, res) => {
  try {
    const content = fs.readFileSync(PROMPT_FILE, "utf8");
    const stat = fs.statSync(PROMPT_FILE);
    res.json({
      ok: true,
      content,
      bytes: content.length,
      updated_at: stat.mtime.toISOString(),
      approx_tokens: Math.round(content.length / 4)
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.put("/api/prompt", (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "content (string, non-empty) required" });
  }
  if (content.length > 200000) {
    return res.status(400).json({ error: "prompt too large (max 200KB)" });
  }
  try {
    if (!fs.existsSync(PROMPT_HISTORY)) fs.mkdirSync(PROMPT_HISTORY, { recursive: true });
    const prev = fs.readFileSync(PROMPT_FILE, "utf8");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const actor = (auth.currentUser(req) && auth.currentUser(req).email) || (req.body.actor || "anonymous");
    const histFile = path.join(PROMPT_HISTORY, `item-review.${ts}.md`);
    fs.writeFileSync(histFile, `<!-- replaced ${ts} by ${actor} -->\n${prev}`);
    fs.writeFileSync(PROMPT_FILE, content);
    // Bust the scorer's cached read so the next score uses the new prompt.
    delete require.cache[require.resolve("./lib/scorer")];
    res.json({
      ok: true,
      bytes: content.length,
      approx_tokens: Math.round(content.length / 4),
      snapshotted_to: path.basename(histFile)
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/prompt/history", (_req, res) => {
  try {
    if (!fs.existsSync(PROMPT_HISTORY)) return res.json({ history: [] });
    const files = fs.readdirSync(PROMPT_HISTORY)
      .filter(f => f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, 20)
      .map(f => {
        const full = path.join(PROMPT_HISTORY, f);
        const stat = fs.statSync(full);
        return { name: f, bytes: stat.size, saved_at: stat.mtime.toISOString() };
      });
    res.json({ history: files });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/prompt/history/:name", (req, res) => {
  const name = req.params.name;
  if (!/^[A-Za-z0-9._-]+\.md$/.test(name)) return res.status(400).json({ error: "invalid name" });
  try {
    const full = path.join(PROMPT_HISTORY, name);
    const content = fs.readFileSync(full, "utf8");
    res.json({ ok: true, name, content });
  } catch {
    res.status(404).json({ error: "not found" });
  }
});

// ---- Activity (decisions over time, optionally per actor) ----
//
// Walks decisions.jsonl, aggregates by actor / verdict / BU / day.
// Used by the Portfolio "your activity" panel and the export endpoint.

function readAllDecisions() {
  if (!fs.existsSync(DECISIONS_FILE)) return [];
  return fs.readFileSync(DECISIONS_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

app.get("/api/activity", (req, res) => {
  const mine = req.query.mine === "1";
  const days = Math.min(365, Math.max(1, parseInt(req.query.days || "30", 10)));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const ssoUser = auth.currentUser(req);
  const targetActor = mine && ssoUser ? (ssoUser.email || ssoUser.name) : null;

  const decisions = readAllDecisions().filter(d => {
    if (d.action === "clear_override") return false;
    if (new Date(d.decided_at).getTime() < cutoff) return false;
    if (targetActor && d.actor !== targetActor) return false;
    return true;
  });

  // Roll up.
  const byVerdict = { KEEP: 0, STOP: 0, FOLD: 0, FLAG: 0 };
  const byBu = {};
  const byActor = {};
  const byDay = {};
  let changed_from_ai = 0;
  for (const d of decisions) {
    byVerdict[d.new_verdict] = (byVerdict[d.new_verdict] || 0) + 1;
    byBu[d.bu_slug] = (byBu[d.bu_slug] || 0) + 1;
    byActor[d.actor || "anonymous"] = (byActor[d.actor || "anonymous"] || 0) + 1;
    const day = d.decided_at.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    if (d.ai_verdict && d.new_verdict !== d.ai_verdict) changed_from_ai++;
  }

  res.json({
    range_days: days,
    actor_filter: targetActor,
    total: decisions.length,
    changed_from_ai,
    confirmed_ai: decisions.length - changed_from_ai,
    by_verdict: byVerdict,
    by_bu: byBu,
    by_actor: byActor,
    by_day: byDay,
    recent: decisions.slice(-20).reverse()
  });
});

// ---- Export: self-contained HTML report per BU ----
//
// Renders a printable / shareable HTML document for one BU using the
// same Daedalus aesthetic as the source scrub HTMLs. Single file, inline
// data + inline CSS, opens directly from the filesystem.

function escHtml(s) {
  return (s == null ? "" : String(s)).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function renderExport(bu) {
  const projects = bu.projects.filter(p => p.items.length > 0);
  const projectRows = projects.map(p => {
    const tally = p.items.reduce((a, i) => { a[i.current_verdict] = (a[i.current_verdict] || 0) + 1; a.total++; return a; }, { KEEP: 0, STOP: 0, FOLD: 0, FLAG: 0, total: 0 });
    const rows = p.items.map(i => {
      const overridden = !!i.override;
      const decided = overridden ? i.override.verdict : null;
      const delta = overridden && decided !== i.ai_verdict;
      const verdictCell = delta
        ? `<span class="pill subtle ${escHtml(i.ai_verdict)}">${escHtml(i.ai_verdict)}</span> → <span class="pill ${escHtml(decided)}">${escHtml(decided)}</span>`
        : `<span class="pill ${escHtml(i.current_verdict)}">${escHtml(i.current_verdict)}</span>`;
      const decidedBy = overridden ? `<div class="decided-by">★ ${escHtml(i.override.actor || "")} · ${escHtml(new Date(i.override.decided_at).toLocaleDateString())}</div>` : "";
      return `<tr class="${overridden ? "is-decided" : ""}${delta ? " is-delta" : ""}">
        <td><a href="${escHtml(i.url)}" target="_blank">${escHtml(i.key)}</a></td>
        <td><div class="summary">${escHtml(i.summary)}</div>${i.parent_key ? `<div class="parent">↳ <b>${escHtml(i.parent_key)}</b>${i.parent_summary ? " · " + escHtml(i.parent_summary) : ""}</div>` : ""}</td>
        <td>${escHtml(i.status || "")}</td>
        <td>${verdictCell}${decidedBy}</td>
        <td>${i.ai_gate ? `G${escHtml(i.ai_gate)}` : ""}</td>
        <td>${escHtml(overridden ? (i.override.reason || i.ai_reason || "") : (i.ai_reason || ""))}</td>
      </tr>`;
    }).join("");
    return `<section class="project">
      <header class="proj">
        <div class="proj-left">
          <span class="pkey">${escHtml(p.key)}</span>
          <span class="pname">${escHtml(p.name)}</span>
          <span class="pcat">${escHtml(p.category)}</span>
        </div>
        <div class="proj-right">
          <span class="pcount">${p.items.length} Epics</span>
          <span class="mini-tally">
            <span class="K"><b>${tally.KEEP}</b>K</span>
            <span class="S"><b>${tally.STOP}</b>S</span>
            <span class="F"><b>${tally.FOLD}</b>F</span>
            <span class="G"><b>${tally.FLAG}</b>!</span>
          </span>
        </div>
      </header>
      <table class="items"><thead><tr>
        <th>Key</th><th>Summary &amp; Initiative</th><th>Status</th><th>Verdict</th><th>Gate</th><th>Reason</th>
      </tr></thead><tbody>${rows}</tbody></table>
    </section>`;
  }).join("");

  const t = bu.tally;
  const signalsHtml = (bu.cross_project_signals || []).map(s => `
    <div class="signal ${s.tone ? escHtml(s.tone) : ""}">
      <h3>${escHtml(s.title || "")}</h3>
      <p>${escHtml(s.body || "")}</p>
    </div>`).join("");
  const signalsBlock = signalsHtml ? `<section><h2>Cross-project signals</h2><div class="signals">${signalsHtml}</div></section>` : "";

  const questionsHtml = (bu.open_questions || []).map(q => `
    <li><div class="q">${escHtml(q.q || q)}</div>${q.unlocks ? `<div class="unlocks">unlocks · ${escHtml(q.unlocks)}</div>` : ""}</li>`).join("");
  const questionsBlock = questionsHtml ? `<section><h2>Open questions</h2><ol class="questions">${questionsHtml}</ol></section>` : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escHtml(bu.name)} — Daedalus scrub</title>
<style>
:root{--bg:#0a0b0d;--bg2:#14161a;--bg3:#1c1f24;--line:#2a2e35;--line2:#1f2329;--text:#c9c5bd;--hi:#f4f1ea;--mid:#8a857c;--low:#5a564f;--accent:#d4a574;--keep:#7d9b6e;--stop:#b85c5c;--fold:#d4a574;--flag:#6b9bb8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header.doc{padding:28px 40px 22px;border-bottom:1px solid var(--line)}
header .eyebrow{font:10px ui-monospace,SFMono-Regular,monospace;letter-spacing:.18em;text-transform:uppercase;color:var(--mid)}
h1,h2,h3{font-family:Georgia,serif;font-weight:400;color:var(--hi);margin:0}
h1{font-size:38px;line-height:1.05;margin:6px 0 10px}
h2{font-size:22px;margin:30px 0 12px}
h3{font-size:16px;margin:0 0 6px}
.sub{color:var(--mid);max-width:980px;font-size:14px}
main{padding:18px 40px 60px;max-width:1880px;margin:0 auto}
.metric-strip{display:flex;border:1px solid var(--line);background:var(--line2);margin:0 0 18px}
.metric{flex:1;padding:14px 18px;background:var(--bg2);border-right:1px solid var(--line2)}
.metric:last-child{border-right:0}
.metric .num{font-family:Georgia,serif;font-size:30px;color:var(--hi);line-height:1}
.metric .label{font:10px ui-monospace,SFMono-Regular,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--mid);margin-top:6px}
.summary{padding:14px 18px;border-left:2px solid var(--accent);background:rgba(212,165,116,.06);color:var(--text);margin:14px 0 22px;white-space:pre-wrap;font-size:14px}
.project{border:1px solid var(--line);background:var(--bg2);margin-top:18px}
.project header.proj{display:flex;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line);gap:18px;flex-wrap:wrap;align-items:baseline}
.pkey{font:11px ui-monospace,SFMono-Regular,monospace;color:var(--accent);letter-spacing:.04em}
.pname{font-family:Georgia,serif;font-size:18px;color:var(--hi);margin-left:10px}
.pcat{font:9px ui-monospace,SFMono-Regular,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--mid);border:1px solid var(--line);padding:2px 6px;margin-left:8px}
.pcount{font:11px ui-monospace,SFMono-Regular,monospace;color:var(--mid)}
.mini-tally{display:inline-flex;gap:8px;font:10px ui-monospace,SFMono-Regular,monospace;color:var(--mid);margin-left:14px}
.mini-tally b{color:var(--hi);font-family:Georgia,serif;font-weight:400;margin-right:2px}
.mini-tally .K b{color:#b6c7a9}.mini-tally .S b{color:#d28d8d}.mini-tally .F b{color:#e2c39e}.mini-tally .G b{color:#a7c5d7}
table.items{width:100%;border-collapse:collapse;table-layout:fixed}
table.items th{background:var(--bg3);text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);font:10px ui-monospace,SFMono-Regular,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
table.items td{padding:11px 12px;font-size:13px;vertical-align:top;border-bottom:1px solid var(--line2);overflow-wrap:anywhere;line-height:1.45}
table.items td:first-child{width:120px;font-family:ui-monospace,SFMono-Regular,monospace;color:var(--hi)}
table.items td:nth-child(3){width:90px}table.items td:nth-child(4){width:200px}table.items td:nth-child(5){width:50px}
.summary{padding:0;border:0;background:none;margin:0;color:var(--hi)}
.parent{font:10px ui-monospace,SFMono-Regular,monospace;color:var(--mid);margin-top:4px}
.parent b{color:var(--accent)}
a{color:var(--hi)}a:hover{color:var(--accent)}
.pill{display:inline-block;padding:3px 9px;border-radius:2px;font:10px ui-monospace,SFMono-Regular,monospace;letter-spacing:.14em;text-transform:uppercase;border:1px solid var(--line);background:var(--bg3)}
.pill.KEEP{border-color:rgba(125,155,110,.5);background:rgba(125,155,110,.13);color:#b6c7a9}
.pill.STOP{border-color:rgba(184,92,92,.5);background:rgba(184,92,92,.13);color:#d28d8d}
.pill.FOLD{border-color:rgba(212,165,116,.55);background:rgba(212,165,116,.14);color:#e2c39e}
.pill.FLAG{border-color:rgba(107,155,184,.55);background:rgba(107,155,184,.13);color:#a7c5d7}
.pill.subtle{opacity:.55}
.decided-by{font:9px ui-monospace,SFMono-Regular,monospace;color:var(--accent);margin-top:4px;letter-spacing:.06em}
tr.is-decided{background:rgba(212,165,116,.04)}
tr.is-delta{background:rgba(212,165,116,.07)}
.signals{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px;margin-top:10px}
.signal{border:1px solid var(--line);background:var(--bg2);padding:14px 16px}
.signal.danger{border-left:2px solid var(--stop)}
.signal p{margin:0;color:var(--text)}
.questions{padding-left:22px;margin-top:10px}
.questions li{margin:8px 0}
.unlocks{font:10px ui-monospace,SFMono-Regular,monospace;color:var(--mid);margin-top:4px}
@media print{body{background:white;color:#111}h1,h2,h3,.metric .num{color:#111}.metric,.project,.signal,.summary,table.items{background:white;color:#111;border-color:#aaa}.pill{border:1px solid #777;color:#111;background:white}a{color:#111}}
</style></head><body>
<header class="doc">
  <div class="eyebrow">Project Daedalus · backlog scrub · ${escHtml(bu.name)}</div>
  <h1>${escHtml(bu.name)} — Scrub Report</h1>
  <div class="sub">${escHtml(bu.bu_summary || "")}</div>
  <div class="sub" style="margin-top:6px;font:11px ui-monospace,SFMono-Regular,monospace">Generated ${escHtml(new Date().toLocaleString())}${bu.scrubbed_by ? ` · scrubbed by ${escHtml(bu.scrubbed_by)}` : ""}${bu.scrubbed_date ? ` · ${escHtml(bu.scrubbed_date)}` : ""}</div>
</header>
<main>
<div class="metric-strip">
  <div class="metric"><div class="num">${t.total}</div><div class="label">Epics scored</div></div>
  <div class="metric"><div class="num">${t.overrides}</div><div class="label">Decisions logged</div></div>
  <div class="metric"><div class="num" style="color:#b6c7a9">${t.KEEP}</div><div class="label">Keep</div></div>
  <div class="metric"><div class="num" style="color:#d28d8d">${t.STOP}</div><div class="label">Stop</div></div>
  <div class="metric"><div class="num" style="color:#e2c39e">${t.FOLD}</div><div class="label">Fold</div></div>
  <div class="metric"><div class="num" style="color:#a7c5d7">${t.FLAG}</div><div class="label">Flag</div></div>
</div>
${projectRows}
${signalsBlock}
${questionsBlock}
</main></body></html>`;
}

app.get("/api/bu/:slug/export.html", (req, res) => {
  const seed = loadSeed();
  const state = loadState();
  const decorated = applyOverrides(seed, state);
  const bu = decorated.bus.find(b => b.slug === req.params.slug);
  if (!bu) return res.status(404).send("BU not found");
  bu.tally = tallyBu(bu);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${bu.slug}-scrub-${new Date().toISOString().slice(0, 10)}.html"`);
  res.send(renderExport(bu));
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
