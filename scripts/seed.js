#!/usr/bin/env node
// Build data/seed.json from the roster + the two example scrub HTMLs.
// Re-run anytime new scrub HTMLs are added.
//
// Item shape (normalized across sources):
//   {
//     key, summary, project_key, bu_slug, type, status, priority,
//     parent_key, parent_summary,
//     ai_verdict, ai_gate, ai_reason, url,
//     child_evidence,  // string of "KEY VERDICT: summary; ..." when available
//     source_file
//   }

const fs = require("fs");
const path = require("path");
const roster = require("./roster");

const UPLOADS = "/root/.claude/uploads/584f6a1a-df3e-4053-989d-092b8f47ed8b";
const DA_HTML = path.join(UPLOADS, "1a4d58c9-AFI_DataAnalytics_Scrub.html");
const SC_HTML = path.join(UPLOADS, "5b36801d-Daedalus_Supply_Chain__Eval.html");

const OUT_DIR = path.join(__dirname, "..", "data");
const SEED_OUT = path.join(OUT_DIR, "seed.json");

function projectToBu() {
  const map = {};
  for (const bu of roster) for (const p of bu.projects) map[p.key] = bu.slug;
  return map;
}
const projectBuMap = projectToBu();

function safeRead(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

// --- Parser: Data Analytics scrub (nested projects -> epics -> children) ---
function parseDataAnalytics(html) {
  if (!html) return null;
  const m = html.match(/<script id="scrub-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  let payload;
  try { payload = JSON.parse(m[1]); }
  catch (e) { console.error("DA parse failed:", e.message); return null; }

  const items = [];
  for (const project of payload.projects || []) {
    const projectKey = project.key;
    const buSlug = projectBuMap[projectKey] || "afi-data-analytics";
    for (const epic of project.epics || []) {
      const childEvidence = (epic.children || [])
        .map(c => `${c.key} ${c.verdict || ""}: ${c.summary || ""}`.trim())
        .join("; ");
      items.push({
        key: epic.epic_key,
        summary: epic.epic_summary,
        project_key: projectKey,
        bu_slug: buSlug,
        type: epic.epic_type || "Epic",
        status: epic.epic_status || "",
        priority: epic.epic_priority || "",
        parent_key: "",
        parent_summary: "",
        ai_verdict: normalizeVerdict(epic.epic_verdict || epic.rollup_verdict),
        ai_gate: extractGate(epic.epic_reason),
        ai_reason: epic.epic_reason || "",
        url: jiraUrl(epic.epic_key),
        child_evidence: childEvidence,
        source_file: "AFI_DataAnalytics_Scrub.html"
      });
      for (const child of epic.children || []) {
        items.push({
          key: child.key,
          summary: child.summary,
          project_key: projectKey,
          bu_slug: buSlug,
          type: child.type || "Story",
          status: child.status || "",
          priority: child.priority || "",
          parent_key: epic.epic_key,
          parent_summary: epic.epic_summary,
          ai_verdict: normalizeVerdict(child.verdict),
          ai_gate: child.gate || extractGate(child.reason),
          ai_reason: child.reason || "",
          url: jiraUrl(child.key),
          child_evidence: "",
          source_file: "AFI_DataAnalytics_Scrub.html"
        });
      }
    }
  }
  return {
    bu_slug: "afi-data-analytics",
    scrubbed_date: payload.scrubbed_date,
    scrubbed_by: payload.scrubbed_by,
    bu_summary: payload.bu_summary,
    cross_project_signals: payload.cross_project_signals || [],
    open_questions: payload.open_questions || [],
    items
  };
}

// --- Parser: Supply Chain scrub (flat rows in const DATA = {...}) ---
function parseSupplyChain(html) {
  if (!html) return null;
  // The DATA literal is on a single line; capture from `const DATA=` to the trailing `;\n`
  const m = html.match(/const DATA\s*=\s*(\{[\s\S]*?\});\s*\n/);
  if (!m) return null;
  let payload;
  try { payload = JSON.parse(m[1]); }
  catch (e) { console.error("SC parse failed:", e.message); return null; }

  const items = (payload.all_rows || []).map(r => ({
    key: r.key,
    summary: r.summary,
    project_key: r.project,
    bu_slug: projectBuMap[r.project] || "afi-supply-chain",
    type: r.project === "SCD" ? "Idea" : "Epic",
    status: r.status || "",
    priority: r.priority || "",
    parent_key: r.parent_key || "",
    parent_summary: r.parent_summary || "",
    ai_verdict: normalizeVerdict(r.recommendation),
    ai_gate: extractGate(r.rationale),
    ai_reason: r.rationale || "",
    url: r.url || jiraUrl(r.key),
    child_evidence: r.child_evidence || "",
    source_file: "Daedalus_Supply_Chain__Eval.html"
  }));

  return {
    bu_slug: "afi-supply-chain",
    scrubbed_date: "2026-05-18",
    scrubbed_by: "Daedalus Backlog Scrub · downstream agent",
    bu_summary: "Epic-first rollup of DSI, GSM, and SCD. Leadership should act on Epic recommendation, not isolated child stories. Child guidance is supporting evidence.",
    cross_project_signals: [],
    open_questions: [],
    items
  };
}

function normalizeVerdict(v) {
  if (!v) return "FLAG";
  const u = String(v).toUpperCase().trim();
  if (u === "CLOSE/REMOVE" || u === "CLOSEREMOVE" || u === "REMOVE" || u === "CLOSE") return "STOP";
  if (["KEEP", "STOP", "FOLD", "FLAG"].includes(u)) return u;
  return "FLAG";
}

function extractGate(text) {
  if (!text) return null;
  const m = String(text).match(/Gate\s*([1-5])/i);
  return m ? Number(m[1]) : null;
}

function jiraUrl(key) {
  return `https://ashley-furniture-team.atlassian.net/browse/${key}`;
}

// --- Build seed ---
const da = parseDataAnalytics(safeRead(DA_HTML));
const sc = parseSupplyChain(safeRead(SC_HTML));

const scrubsByBu = {};
for (const scrub of [da, sc].filter(Boolean)) {
  scrubsByBu[scrub.bu_slug] = scrub;
}

const seed = {
  generated_at: new Date().toISOString(),
  source_files: [
    da ? "AFI_DataAnalytics_Scrub.html" : null,
    sc ? "Daedalus_Supply_Chain__Eval.html" : null
  ].filter(Boolean),
  bus: roster.map(bu => {
    const scrub = scrubsByBu[bu.slug];
    const items = scrub ? scrub.items : [];
    const itemsByProject = {};
    for (const it of items) {
      (itemsByProject[it.project_key] = itemsByProject[it.project_key] || []).push(it);
    }
    return {
      slug: bu.slug,
      name: bu.name,
      project_count: bu.projects.length,
      item_count: items.length,
      scrubbed_date: scrub ? scrub.scrubbed_date : null,
      scrubbed_by: scrub ? scrub.scrubbed_by : null,
      bu_summary: scrub ? scrub.bu_summary : "",
      cross_project_signals: scrub ? scrub.cross_project_signals : [],
      open_questions: scrub ? scrub.open_questions : [],
      projects: bu.projects.map(p => ({
        key: p.key,
        name: p.name,
        category: p.category,
        item_count: (itemsByProject[p.key] || []).length,
        items: itemsByProject[p.key] || []
      }))
    };
  })
};

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(SEED_OUT, JSON.stringify(seed, null, 2));

const totalItems = seed.bus.reduce((n, b) => n + b.item_count, 0);
const populated = seed.bus.filter(b => b.item_count > 0).length;
console.log(`Wrote ${SEED_OUT}`);
console.log(`  BUs: ${seed.bus.length} (${populated} populated, ${seed.bus.length - populated} empty)`);
console.log(`  Items: ${totalItems}`);
