// Client logic for the scrub console.
// Two screens: BU list (#/) and BU detail (#/bu/<slug>).
// State (filters, actor name) lives in this module and in localStorage.

const VERDICTS = ["KEEP", "STOP", "FOLD", "FLAG"];
const ACTOR_KEY = "scrub_actor";

const app = document.getElementById("app");
const modal = document.getElementById("modal");
const modalBody = document.getElementById("modal-body");
const actorInput = document.getElementById("actor");
const refreshAllBtn = document.getElementById("refreshAll");
const generatedEl = document.getElementById("generated");
const buJump = document.getElementById("bu-jump");
const scorerStatusEl = document.getElementById("scorer-status");
const jiraStatusEl = document.getElementById("jira-status");
const navLinks = document.querySelectorAll(".navlink[data-route]");

// Cached BU list so the switcher doesn't refetch on every navigation.
let _busCache = null;
async function getBus() {
  if (_busCache) return _busCache;
  const data = await api("GET", "/api/bus");
  _busCache = data;
  populateBuJump(data);
  return data;
}
function populateBuJump(data) {
  if (!buJump) return;
  const current = location.hash.startsWith("#/bu/") ? location.hash.slice(5) : "";
  const opts = ["<option value=\"\">— select BU —</option>"];
  for (const bu of data.bus) {
    const empty = (bu.item_count || 0) === 0 ? " · empty" : ` · ${bu.item_count}`;
    opts.push(`<option value="${esc(bu.slug)}" ${bu.slug === current ? "selected" : ""}>${esc(bu.name)}${empty}</option>`);
  }
  buJump.innerHTML = opts.join("");
}
if (buJump) {
  buJump.addEventListener("change", () => {
    if (buJump.value) location.hash = `#/bu/${buJump.value}`;
  });
}

function setNavActive() {
  const onHome = !location.hash || location.hash === "#" || location.hash === "#/";
  navLinks.forEach(a => a.classList.toggle("active", a.dataset.route === (onHome ? "home" : "")));
  // Keep the switcher in sync with current route.
  if (buJump) {
    const cur = location.hash.startsWith("#/bu/") ? location.hash.slice(5) : "";
    if (cur !== buJump.value) buJump.value = cur;
  }
}

async function refreshHeaderStatus() {
  // Scorer status
  try {
    const s = await api("GET", "/api/scorer/info");
    scorerStatusEl.className = "status " + (s.configured ? "ok" : "warn");
    scorerStatusEl.innerHTML = `<span class="dot"></span>scorer · ${esc(s.configured ? s.provider : "not configured")}`;
  } catch {
    scorerStatusEl.className = "status err";
    scorerStatusEl.innerHTML = `<span class="dot"></span>scorer · error`;
  }
  // Jira status
  try {
    const j = await api("GET", "/api/jira/status");
    if (!j.configured) {
      jiraStatusEl.className = "status warn";
      jiraStatusEl.innerHTML = `<span class="dot"></span>jira · offline`;
    } else if (j.ping_ok === false || j.error) {
      jiraStatusEl.className = "status warn";
      jiraStatusEl.innerHTML = `<span class="dot"></span>jira · stubs`;
    } else {
      jiraStatusEl.className = "status ok";
      jiraStatusEl.innerHTML = `<span class="dot"></span>jira · live`;
    }
  } catch {
    jiraStatusEl.className = "status err";
    jiraStatusEl.innerHTML = `<span class="dot"></span>jira · error`;
  }
}

// ---- helpers ----
const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString() : "—";

function getActor() { return actorInput.value.trim() || localStorage.getItem(ACTOR_KEY) || "anonymous"; }
function saveActor() { if (actorInput.value.trim()) localStorage.setItem(ACTOR_KEY, actorInput.value.trim()); }
actorInput.value = localStorage.getItem(ACTOR_KEY) || "";
actorInput.addEventListener("change", saveActor);
actorInput.addEventListener("blur", saveActor);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}

function verdictBar(t) {
  if (!t || !t.total) return `<div class="verdict-bar"></div>`;
  const segs = VERDICTS.map(v => `<span class="seg-${v}" style="width:${(100 * (t[v] || 0)) / t.total}%"></span>`).join("");
  return `<div class="verdict-bar">${segs}</div>`;
}

// ---- routing ----
window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", () => {
  refreshHeaderStatus();
  getBus().catch(() => {});
  route();
});

function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  setNavActive();
  if (hash.startsWith("/bu/")) renderBu(hash.slice(4));
  else renderLanding();
}

refreshAllBtn.addEventListener("click", async () => {
  refreshAllBtn.disabled = true;
  refreshAllBtn.dataset.orig = refreshAllBtn.textContent;
  refreshAllBtn.innerHTML = `<span class="spinner-sm"></span> Refreshing`;
  try {
    await api("POST", "/api/refresh");
    _busCache = null;
    await refreshHeaderStatus();
    route();
  } finally {
    refreshAllBtn.disabled = false;
    refreshAllBtn.textContent = refreshAllBtn.dataset.orig || "Refresh all";
  }
});

// ---- landing: list of BUs ----
async function renderLanding() {
  let data;
  try {
    // Always refetch on landing so portfolio totals reflect any decisions
    // made on a BU page since the cache was first warmed.
    data = await api("GET", "/api/bus");
    _busCache = data;
    populateBuJump(data);
  } catch (e) { app.innerHTML = `<div class="note">Could not load BUs: ${esc(e.message)}</div>`; return; }
  generatedEl.textContent = `seed · ${data.generated_at ? new Date(data.generated_at).toLocaleDateString() : "—"}`;

  // Roll the BU tallies up into a portfolio summary so the landing
  // page leads with totals instead of just a grid.
  const totals = { KEEP: 0, STOP: 0, FOLD: 0, FLAG: 0, total: 0, overrides: 0 };
  let populated = 0;
  for (const bu of data.bus) {
    const t = bu.tally || {};
    for (const v of VERDICTS) totals[v] += t[v] || 0;
    totals.total += t.total || 0;
    totals.overrides += t.overrides || 0;
    if ((bu.item_count || 0) > 0) populated++;
  }

  app.innerHTML = `
    <div class="eyebrow">portfolio · 17 business units · 91 projects</div>
    <h2 style="margin-top:6px;margin-bottom:14px">Scrub console</h2>

    <div class="portfolio">
      <div class="cell"><div class="num">${totals.total}</div><div class="label">Epics scored</div></div>
      <div class="cell"><div class="num">${populated}<span style="color:var(--low);font-size:18px">/${data.bus.length}</span></div><div class="label">BUs populated</div></div>
      <div class="cell accent"><div class="num">${totals.overrides}</div><div class="label">Decisions logged</div></div>
      <div class="cell split">
        <div class="item"><div class="num" style="color:#b6c7a9">${totals.KEEP}</div><div class="label">Keep</div></div>
        <div class="item"><div class="num" style="color:#d28d8d">${totals.STOP}</div><div class="label">Stop</div></div>
        <div class="item"><div class="num" style="color:#e2c39e">${totals.FOLD}</div><div class="label">Fold</div></div>
        <div class="item"><div class="num" style="color:#a7c5d7">${totals.FLAG}</div><div class="label">Flag</div></div>
      </div>
    </div>

    <h2 style="margin-bottom:8px">Business units</h2>
    <div class="sub" style="color:var(--mid);margin:0 0 16px;font-size:14px">Click a populated BU to walk its Epics. Empty BUs are placeholders — use <b style="color:var(--hi)">Add items…</b> on any BU page to ingest scored Epics.</div>
    <div class="bu-grid" id="bu-grid"></div>
  `;

  const grid = document.getElementById("bu-grid");

  // Sort: populated first (by item count desc), then empty.
  const sorted = data.bus.slice().sort((a, b) => {
    const ap = (a.item_count || 0) > 0 ? 1 : 0;
    const bp = (b.item_count || 0) > 0 ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return (b.item_count || 0) - (a.item_count || 0);
  });

  for (const bu of sorted) {
    const t = bu.tally || { KEEP: 0, STOP: 0, FOLD: 0, FLAG: 0, total: 0, overrides: 0 };
    const empty = bu.item_count === 0;
    const counts = VERDICTS.map(v => `<span><b>${t[v] || 0}</b> ${v}</span>`).join("");
    const card = document.createElement("a");
    card.className = "bu-card" + (empty ? " empty" : "");
    card.href = `#/bu/${bu.slug}`;
    card.innerHTML = `
      <div class="name">${esc(bu.name)}</div>
      <div class="stats">${bu.project_count} projects · ${bu.item_count} items${t.overrides ? ` · <b style="color:var(--accent)">${t.overrides} overrides</b>` : ""}${empty ? ' · <span class="empty-tag">empty</span>' : ""}</div>
      ${verdictBar(t)}
      <div class="mini-counts">${counts}</div>
    `;
    grid.appendChild(card);
  }
}

// ---- BU detail ----
const filterState = { verdict: null, status: null, project: null, gate: null, initiative: null, search: "", quick: null };

const QUICK_FILTERS = [
  { id: "attention", label: "Needs attention", match: it => it.current_verdict === "FLAG" || (it.ai_meta && it.ai_meta.confidence === "low") },
  { id: "overrides", label: "My overrides", match: it => !!it.override },
  { id: "unlinked", label: "Unlinked Epics", match: it => !it.parent_key }
];

async function renderBu(slug) {
  app.innerHTML = `<div class="crumb">
      <a href="#/">Portfolio</a>
      <span class="crumb-sep">›</span>
      <span id="cur"></span>
    </div>
    <div id="bu-body">Loading…</div>`;
  let bu;
  try { bu = await api("GET", `/api/bu/${encodeURIComponent(slug)}`); }
  catch (e) { document.getElementById("bu-body").innerHTML = `<div class="note">Could not load BU: ${esc(e.message)}</div>`; return; }
  document.getElementById("cur").textContent = bu.name;
  generatedEl.textContent = bu.scrubbed_date ? `scrub · ${bu.scrubbed_date}` : `not yet scrubbed`;

  Object.assign(filterState, { verdict: null, status: null, project: null, gate: null, initiative: null, search: "", quick: null });

  // Pre-compute which items match each quick filter so chips can show counts.
  for (const it of bu.projects.flatMap(p => p.items)) {
    it._qf = new Set();
    for (const q of QUICK_FILTERS) if (q.match(it)) it._qf.add(q.id);
  }

  document.getElementById("bu-body").innerHTML = renderBuHtml(bu);
  bindBuEvents(bu);
}

function renderBuHtml(bu) {
  const t = bu.tally;
  // Sort populated projects by item count desc so the heaviest project
  // sits at the top.
  const projects = bu.projects
    .filter(p => p.items.length > 0)
    .sort((a, b) => b.items.length - a.items.length);
  const emptyProjects = bu.projects.filter(p => p.items.length === 0);
  const projectOpts = bu.projects.map(p => `<option value="${esc(p.key)}">${esc(p.key)} — ${esc(p.name)}</option>`).join("");
  const statuses = Array.from(new Set(bu.projects.flatMap(p => p.items.map(i => i.status).filter(Boolean)))).sort();
  const statusOpts = statuses.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");

  // Initiatives observed in this BU. Sort by count desc; "(unlinked)" at the tail.
  const initMap = new Map();
  for (const p of bu.projects) for (const it of p.items) {
    const k = it.parent_key || "";
    if (!initMap.has(k)) initMap.set(k, { key: k, summary: it.parent_summary || "", count: 0 });
    initMap.get(k).count += 1;
  }
  const initiatives = Array.from(initMap.values()).sort((a, b) => {
    if (!a.key && b.key) return 1;
    if (a.key && !b.key) return -1;
    return b.count - a.count;
  });
  const initiativeOpts = initiatives.map(i => {
    const label = i.key
      ? `${i.key}${i.summary ? " — " + i.summary : ""} (${i.count})`
      : `(unlinked) (${i.count})`;
    return `<option value="${esc(i.key || "__unlinked__")}">${esc(label)}</option>`;
  }).join("");

  const signalsHtml = bu.cross_project_signals && bu.cross_project_signals.length
    ? `<h2>Cross-project signals</h2><div class="signals">${bu.cross_project_signals.map(s => `
        <div class="signal ${s.tone ? esc(s.tone) : ""}">
          <h3>${esc(s.title || "")}</h3>
          <p>${esc(s.body || "")}</p>
        </div>`).join("")}</div>` : "";

  const questionsHtml = bu.open_questions && bu.open_questions.length
    ? `<h2>Open questions for human review</h2><ol class="questions">${bu.open_questions.map(q => `
        <li><div class="q">${esc(q.q || q)}</div>${q.unlocks ? `<div class="unlocks">unlocks · ${esc(q.unlocks)}</div>` : ""}</li>`).join("")}</ol>` : "";

  const emptyHtml = emptyProjects.length
    ? `<div class="note"><b>${emptyProjects.length} project${emptyProjects.length === 1 ? "" : "s"}</b> in this BU have no scored Epics yet: ${emptyProjects.map(p => `<code>${esc(p.key)}</code>`).join(" ")}. Use <b>Add items…</b> to ingest Epics for these projects.</div>`
    : "";

  const buEmptyHtml = bu.item_count === 0
    ? `<div class="cta-empty">
        <h3>${esc(bu.name)} has no scored Epics yet</h3>
        <p>Ingest Epics for any of this BU's ${bu.projects.length} project${bu.projects.length === 1 ? "" : "s"} (${bu.projects.map(p => p.key).join(", ")}) to start scoring. Single Epic or bulk JSON paste — both work.</p>
        <button class="mini-btn primary" id="ingestEmptyBu">Add the first Epic</button>
      </div>`
    : "";

  // Quick-filter chips — compute counts in the calling scope.
  const allItems = bu.projects.flatMap(p => p.items);
  const qfCounts = {};
  for (const q of QUICK_FILTERS) qfCounts[q.id] = allItems.filter(q.match).length;
  const qfHtml = bu.item_count > 0 ? `
    <div class="quick-filters">
      <span class="label">quick</span>
      ${QUICK_FILTERS.map(q => `<button class="qf" data-qf="${q.id}">${esc(q.label)} <b>${qfCounts[q.id]}</b></button>`).join("")}
    </div>` : "";

  return `
    <h1 style="margin-top:6px">${esc(bu.name)}</h1>
    ${bu.scrubbed_by ? `<div class="eyebrow" style="margin-top:6px">scrubbed by ${esc(bu.scrubbed_by)} · ${esc(bu.scrubbed_date || "")}</div>` : ""}
    ${bu.bu_summary ? `<div class="summary">${esc(bu.bu_summary)}</div>` : ""}
    ${buEmptyHtml}
    <div class="metric-strip">
      <div class="metric"><div class="num">${t.total}</div><div class="label">Items scored</div></div>
      <div class="metric"><div class="num">${bu.projects.length}</div><div class="label">Projects</div></div>
      <div class="metric"><div class="num">${t.overrides}</div><div class="label">Overrides logged</div></div>
      <div class="metric"><div class="num">${projects.length}</div><div class="label">Populated projects</div></div>
    </div>
    <div class="rec-strip" id="verdict-chips">
      ${VERDICTS.map(v => `<span class="rec-chip ${v}" data-verdict="${v}"><b>${t[v] || 0}</b>${v}</span>`).join("")}
    </div>
    ${qfHtml}
    <div class="toolbar">
      <div class="filters">
        <select id="f-initiative"><option value="">All initiatives</option>${initiativeOpts}</select>
        <select id="f-project"><option value="">All projects</option>${projectOpts}</select>
        <select id="f-status"><option value="">All statuses</option>${statusOpts}</select>
        <select id="f-gate"><option value="">All gates</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select>
        <span class="search-wrap"><input class="q" id="f-q" placeholder="search key, summary, reason…" size="34"><span class="kbd">/</span></span>
        <span class="filter-count" id="filter-count"></span>
      </div>
      <div class="filters">
        <button class="mini-btn" id="resetFilters">Reset</button>
        <button class="mini-btn" id="refreshBu">Refresh BU</button>
        <button class="mini-btn primary" id="ingestBu">Add items…</button>
      </div>
    </div>
    ${emptyHtml}
    <div id="projects">${projects.map((p, i) => renderProject(p, i === 0)).join("")}</div>
    <div id="empty-filter" class="empty-filter" style="display:none">
      <b>No Epics match the current filters</b>
      Try adjusting a filter or clearing the search.
      <div><button class="mini-btn" data-reset-filters>Reset all filters</button></div>
    </div>
    ${signalsHtml}
    ${questionsHtml}
  `;
}

function renderProject(p, openByDefault) {
  const tally = p.items.reduce((a, i) => { a[i.current_verdict] = (a[i.current_verdict] || 0) + 1; a.total++; return a; }, { KEEP: 0, STOP: 0, FOLD: 0, FLAG: 0, total: 0 });
  const collapsed = openByDefault ? "" : " collapsed";
  return `
    <section class="project${collapsed}" data-project="${esc(p.key)}">
      <header class="proj">
        <div class="proj-left">
          <span class="chev">▶</span>
          <span class="pkey">${esc(p.key)}</span>
          <span class="pname">${esc(p.name)}</span>
          <span class="pcat">${esc(p.category)}</span>
        </div>
        <div class="proj-right">
          <span class="pcount"><b>${p.items.length}</b> Epic${p.items.length === 1 ? "" : "s"}</span>
          <span class="mini-tally">
            <span class="K"><b>${tally.KEEP}</b>K</span>
            <span class="S"><b>${tally.STOP}</b>S</span>
            <span class="F"><b>${tally.FOLD}</b>F</span>
            <span class="G"><b>${tally.FLAG}</b>!</span>
          </span>
          ${verdictBar(tally)}
          <button class="mini-btn refresh-proj" data-key="${esc(p.key)}">Refresh</button>
        </div>
      </header>
      <div class="body">
        <table class="items">
          <thead><tr>
            <th class="col-key">Key</th>
            <th class="col-summary">Summary &amp; parent Initiative</th>
            <th class="col-status">Status</th>
            <th class="col-prio">Priority</th>
            <th class="col-verdict">Verdict</th>
            <th class="col-gate">Gate</th>
            <th class="col-reason">Reason</th>
            <th class="col-actions">Decide</th>
          </tr></thead>
          <tbody>${p.items.map(renderItemRow).join("")}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderItemRow(it) {
  const url = it.url || `https://ashley-furniture-team.atlassian.net/browse/${encodeURIComponent(it.key)}`;
  const dot = it.override ? `<span class="override-dot" title="overridden"></span>` : "";
  const qfAttr = it._qf ? Array.from(it._qf).join(",") : "";
  return `
    <tr data-key="${esc(it.key)}" data-verdict="${esc(it.current_verdict)}" data-status="${esc(it.status || "")}" data-gate="${esc(it.ai_gate || "")}" data-project="${esc(it.project_key)}" data-initiative="${esc(it.parent_key || "__unlinked__")}" data-qf="${esc(qfAttr)}">
      <td><a class="key" href="${esc(url)}" target="_blank" rel="noopener" data-noopen>${esc(it.key)}</a></td>
      <td>
        <div class="summary">${esc(it.summary || "")}</div>
        ${it.parent_key
          ? `<div class="parent-tag">↳ <b>${esc(it.parent_key)}</b>${it.parent_summary ? " · " + esc(it.parent_summary) : ""}</div>`
          : `<div class="parent-tag unlinked">↳ no parent Initiative</div>`}
        ${it.child_evidence ? `<div class="child-evidence">${esc(it.child_evidence)}</div>` : ""}
      </td>
      <td>${esc(it.status || "")}</td>
      <td>${esc(it.priority || "")}</td>
      <td><span class="pill ${esc(it.current_verdict)}">${esc(it.current_verdict)}</span>${dot}</td>
      <td>${it.ai_gate ? `<span class="gate">G${esc(it.ai_gate)}</span>` : ""}</td>
      <td>${esc(it.override ? it.override.reason || it.ai_reason : it.ai_reason || "")}</td>
      <td>
        <div class="actions">
          ${VERDICTS.map(v => `<button class="act ${v}" data-action="set" data-verdict="${v}" title="Set ${v}">${v === "STOP" ? "Kill" : v}</button>`).join("")}
          <button class="act hist" data-action="open" title="Open decision modal">…</button>
        </div>
      </td>
    </tr>
  `;
}

function bindBuEvents(bu) {
  // verdict chips
  document.querySelectorAll(".rec-chip[data-verdict]").forEach(chip => {
    chip.addEventListener("click", () => {
      const v = chip.dataset.verdict;
      filterState.verdict = filterState.verdict === v ? null : v;
      document.querySelectorAll(".rec-chip[data-verdict]").forEach(c => c.classList.toggle("active", c.dataset.verdict === filterState.verdict));
      applyFilters();
    });
  });

  const fInit = document.getElementById("f-initiative");
  const fProj = document.getElementById("f-project");
  const fStatus = document.getElementById("f-status");
  const fGate = document.getElementById("f-gate");
  const fQ = document.getElementById("f-q");
  fInit.addEventListener("change", () => { filterState.initiative = fInit.value || null; applyFilters(); });
  fProj.addEventListener("change", () => { filterState.project = fProj.value || null; applyFilters(); });
  fStatus.addEventListener("change", () => { filterState.status = fStatus.value || null; applyFilters(); });
  fGate.addEventListener("change", () => { filterState.gate = fGate.value || null; applyFilters(); });
  fQ.addEventListener("input", () => { filterState.search = fQ.value.toLowerCase(); applyFilters(); });
  document.getElementById("resetFilters").addEventListener("click", () => {
    Object.assign(filterState, { verdict: null, status: null, project: null, gate: null, initiative: null, search: "", quick: null });
    fInit.value = ""; fProj.value = ""; fStatus.value = ""; fGate.value = ""; fQ.value = "";
    document.querySelectorAll(".rec-chip[data-verdict]").forEach(c => c.classList.remove("active"));
    document.querySelectorAll(".qf").forEach(c => c.classList.remove("active"));
    applyFilters();
  });

  // Quick filter chips.
  document.querySelectorAll(".qf").forEach(chip => {
    chip.addEventListener("click", () => {
      const id = chip.dataset.qf;
      filterState.quick = filterState.quick === id ? null : id;
      document.querySelectorAll(".qf").forEach(c => c.classList.toggle("active", c.dataset.qf === filterState.quick));
      applyFilters();
    });
  });

  const setLoading = (btn, label) => {
    btn.disabled = true;
    btn.dataset.origText = btn.textContent;
    btn.innerHTML = `<span class="spinner-sm"></span> ${esc(label)}`;
  };
  const clearLoading = (btn) => {
    btn.disabled = false;
    if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
  };

  document.getElementById("refreshBu").addEventListener("click", async (e) => {
    setLoading(e.target, "Refreshing");
    try { await api("POST", `/api/refresh/bu/${encodeURIComponent(bu.slug)}`); }
    catch (err) { /* fall through to clearLoading */ }
    finally { clearLoading(e.target); }
    renderBu(bu.slug);
  });

  document.getElementById("ingestBu").addEventListener("click", () => openIngestModal(bu));
  const ingestEmpty = document.getElementById("ingestEmptyBu");
  if (ingestEmpty) ingestEmpty.addEventListener("click", () => openIngestModal(bu));

  document.querySelectorAll(".refresh-proj").forEach(b => {
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      setLoading(b, "Refreshing");
      try { await api("POST", `/api/refresh/project/${encodeURIComponent(b.dataset.key)}`); }
      catch (err) { /* fall through */ }
      finally { clearLoading(b); }
      renderBu(bu.slug);
    });
  });

  // Reset buttons in the empty-filter pane reuse the toolbar's reset action.
  document.querySelectorAll("[data-reset-filters]").forEach(b => {
    b.addEventListener("click", () => document.getElementById("resetFilters").click());
  });

  // Collapse project sections
  document.querySelectorAll(".project header.proj").forEach(h => {
    h.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.closest("a")) return;
      h.parentElement.classList.toggle("collapsed");
    });
  });

  // Row actions: click anywhere on the row (except the Jira-link or the
  // hover-revealed verdict buttons) to open the decision modal.
  document.querySelectorAll("table.items tbody tr").forEach(tr => {
    tr.addEventListener("click", (e) => {
      const key = tr.dataset.key;
      const btn = e.target.closest("button[data-action]");
      if (btn) {
        if (btn.dataset.action === "set") openDecisionModal(key, btn.dataset.verdict, bu);
        else if (btn.dataset.action === "open") openDecisionModal(key, null, bu);
        return;
      }
      // Bare row click. Ignore if user clicked the external Jira link.
      if (e.target.closest("[data-noopen]")) return;
      openDecisionModal(key, null, bu);
    });
  });

  applyFilters();
}

// "/" focuses search; only when not already typing in an input.
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
  if (inField) return;
  const q = document.getElementById("f-q");
  if (q) { e.preventDefault(); q.focus(); q.select(); }
});

function applyFilters() {
  const rows = document.querySelectorAll("table.items tbody tr");
  let total = 0;
  let shown = 0;
  rows.forEach(tr => {
    total++;
    const v = tr.dataset.verdict;
    const s = tr.dataset.status;
    const g = tr.dataset.gate;
    const p = tr.dataset.project;
    const init = tr.dataset.initiative;
    const qf = (tr.dataset.qf || "").split(",").filter(Boolean);
    const text = tr.textContent.toLowerCase();
    let show = true;
    if (filterState.verdict && v !== filterState.verdict) show = false;
    if (filterState.status && s !== filterState.status) show = false;
    if (filterState.gate && String(g) !== String(filterState.gate)) show = false;
    if (filterState.project && p !== filterState.project) show = false;
    if (filterState.initiative && init !== filterState.initiative) show = false;
    if (filterState.quick && !qf.includes(filterState.quick)) show = false;
    if (filterState.search && !text.includes(filterState.search)) show = false;
    tr.style.display = show ? "" : "none";
    if (show) shown++;
  });

  // Hide project sections that have zero visible rows. Auto-expand any
  // section that has visible rows while a filter is active, so users
  // don't have to expand each project to see their hits.
  const filtering = !!(filterState.verdict || filterState.status || filterState.gate || filterState.project || filterState.initiative || filterState.quick || filterState.search);
  document.querySelectorAll(".project").forEach(sec => {
    const visible = sec.querySelectorAll("table.items tbody tr:not([style*='display: none'])").length;
    sec.style.display = visible === 0 ? "none" : "";
    if (filtering && visible > 0) sec.classList.remove("collapsed");
  });

  // Update filter count + empty state.
  const fc = document.getElementById("filter-count");
  if (fc) {
    fc.innerHTML = filtering
      ? `<b>${shown}</b> of ${total} shown`
      : `${total} Epics`;
  }
  const empty = document.getElementById("empty-filter");
  if (empty) empty.style.display = (filtering && shown === 0) ? "" : "none";
}

// ---- modal ----
async function openDecisionModal(key, preselect, bu) {
  let payload;
  try { payload = await api("GET", `/api/item/${encodeURIComponent(key)}`); }
  catch (e) { alert("Could not load item: " + e.message); return; }
  const { item, project, history } = payload;
  let chosen = preselect || (item.override ? item.override.verdict : item.ai_verdict);

  modalBody.innerHTML = `
    <div class="eyebrow">${esc(project.key)} · ${esc(project.name)}</div>
    <h3>${esc(item.key)} — ${esc(item.summary || "")}</h3>
    <div class="ai-line">AI verdict: <span class="pill ${esc(item.ai_verdict)}">${esc(item.ai_verdict)}</span> ${item.ai_gate ? `· Gate ${esc(item.ai_gate)}` : ""} · <a href="${esc(item.url)}" target="_blank" rel="noopener">open in Jira</a></div>
    <div style="font-size:13px;color:var(--text);margin-bottom:6px">${esc(item.ai_reason || "")}</div>

    <label>Set verdict</label>
    <div class="verdict-row" id="v-row">
      ${VERDICTS.map(v => {
        const label = v === "STOP" ? "STOP / KILL" : v;
        const k = v[0]; // K / S / F / L
        return `<button data-v="${v}" data-key="${k}" class="${v === chosen ? "selected" : ""}">${label}<span class="k">${k}</span></button>`;
      }).join("")}
    </div>

    <label>Reason (optional but recommended)</label>
    <textarea id="reason" placeholder="Why this verdict? Cite the gate.">${esc(item.override ? item.override.reason : "")}</textarea>

    <div class="row">
      ${item.override ? `<button class="mini-btn" id="clear">Clear override</button>` : ""}
      <button class="mini-btn" id="cancel">Cancel</button>
      <button class="mini-btn primary" id="save">Save decision</button>
    </div>

    <div class="footer-hint">
      <span><kbd>K</kbd>/<kbd>S</kbd>/<kbd>F</kbd>/<kbd>L</kbd> set verdict</span>
      <span><kbd>⌘</kbd>+<kbd>Enter</kbd> save</span>
      <span><kbd>Esc</kbd> close</span>
    </div>

    ${renderAiBlock(item.ai_meta)}

    ${history && history.length ? `<div class="history">
      <h4>Decision log (${history.length})</h4>
      ${history.slice().reverse().map(h => `
        <div class="history-row">
          <span class="when">${esc(fmtDate(h.decided_at))}</span>
          <span class="who">${esc(h.actor || "anonymous")}</span>
          <span>${h.action === "clear_override" ? `cleared override (was ${esc(h.previous_verdict)})` : `${esc(h.previous_verdict || "—")} → <b>${esc(h.new_verdict)}</b>`}</span>
          ${h.reason ? `<span style="flex-basis:100%;color:var(--mid)">${esc(h.reason)}</span>` : ""}
        </div>`).join("")}
    </div>` : ""}
  `;
  modal.classList.add("open");

  const reasonEl = modalBody.querySelector("#reason");
  const saveBtn = modalBody.querySelector("#save");
  const setChosen = (v) => {
    chosen = v;
    modalBody.querySelectorAll("#v-row button").forEach(x => x.classList.toggle("selected", x.dataset.v === chosen));
  };

  modalBody.querySelectorAll("#v-row button").forEach(b => {
    b.addEventListener("click", () => setChosen(b.dataset.v));
  });
  modalBody.querySelector("#cancel").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); }, { once: true });

  // Keyboard: K/S/F/L pick verdict, Cmd/Ctrl+Enter saves. Skip single-letter
  // shortcuts while the textarea is focused so the user can type freely.
  const onKey = (e) => {
    if (!modal.classList.contains("open")) {
      document.removeEventListener("keydown", onKey);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      saveBtn.click();
      return;
    }
    if (document.activeElement === reasonEl) return;
    const k = e.key.toUpperCase();
    const found = VERDICTS.find(v => v[0] === k);
    if (found) { e.preventDefault(); setChosen(found); }
  };
  document.addEventListener("keydown", onKey);
  setTimeout(() => { if (reasonEl) reasonEl.focus(); }, 30);

  modalBody.querySelector("#save").addEventListener("click", async () => {
    if (!chosen) { alert("Pick a verdict."); return; }
    saveActor();
    try {
      await api("POST", "/api/decision", {
        key: item.key,
        verdict: chosen,
        reason: modalBody.querySelector("#reason").value.trim(),
        actor: getActor()
      });
      closeModal();
      renderBu(bu.slug);
    } catch (e) { alert("Save failed: " + e.message); }
  });

  const clearBtn = modalBody.querySelector("#clear");
  if (clearBtn) clearBtn.addEventListener("click", async () => {
    if (!confirm("Clear the override and revert to the AI verdict?")) return;
    try {
      await api("DELETE", `/api/decision/${encodeURIComponent(item.key)}`, { actor: getActor() });
      closeModal();
      renderBu(bu.slug);
    } catch (e) { alert("Clear failed: " + e.message); }
  });
}

function closeModal() { modal.classList.remove("open"); modalBody.innerHTML = ""; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

function renderAiBlock(meta) {
  if (!meta) return "";
  const deps = (meta.dependencies || []).map(d => `<li><b>${esc(d.type)}</b> ${esc(d.ref)} — ${esc(d.note)}</li>`).join("");
  const needs = (meta.needs_to_resolve || []).map(n => `<li>${esc(n)}</li>`).join("");
  const qs = (meta.questions_for_human || []).map(q => `<li><b>${esc(q.q)}</b> — ${esc(q.unlocks)}</li>`).join("");
  const harvest = meta.harvest && meta.harvest.applies
    ? `<div class="nest"><b>Harvest target:</b> ${esc(meta.harvest.target || "")}<br/>${esc(meta.harvest.note || "")}</div>` : "";
  return `<div class="ai-block">
    <h4>AI analysis · ${esc(meta.provider || "")} ${esc(meta.model || "")}</h4>
    <div class="row-2">
      <div>confidence · <b>${esc(meta.confidence || "—")}</b></div>
      <div>effort · <b>${esc(meta.effort_estimate || "—")}</b></div>
      ${meta.tentative_verdict ? `<div>tentative · <b>${esc(meta.tentative_verdict)}</b></div>` : ""}
      ${meta.staleness_days != null ? `<div>staleness · <b>${esc(meta.staleness_days)}d</b></div>` : ""}
    </div>
    ${meta.rationale ? `<div class="nest">${esc(meta.rationale)}</div>` : ""}
    ${harvest}
    ${deps ? `<div class="nest"><b>Dependencies</b><ul>${deps}</ul></div>` : ""}
    ${needs ? `<div class="nest"><b>Needs to resolve</b><ul>${needs}</ul></div>` : ""}
    ${qs ? `<div class="nest"><b>Questions for human</b><ul>${qs}</ul></div>` : ""}
    ${meta.notes ? `<div class="nest" style="color:var(--mid)">${esc(meta.notes)}</div>` : ""}
  </div>`;
}

// ---- Ingest modal ----
async function openIngestModal(bu) {
  let scorer;
  try { scorer = await api("GET", "/api/scorer/info"); } catch { scorer = { configured: false }; }

  const projectOpts = bu.projects.map(p => `<option value="${esc(p.key)}">${esc(p.key)} — ${esc(p.name)}</option>`).join("");
  const cfgNote = scorer.configured
    ? `<div class="eyebrow" style="color:var(--keep)">scorer · ${esc(scorer.provider)} · ${esc(scorer.model)}</div>`
    : `<div class="eyebrow" style="color:var(--stop)">scorer not configured — set SCORER_PROVIDER and credentials in .env</div>`;

  modalBody.innerHTML = `
    ${cfgNote}
    <h3>Add Epics to ${esc(bu.name)}</h3>
    <div class="ai-line">Scoring is <b>Epic-level only</b> — child Stories/Tasks roll up under their parent Epic as evidence. Initiative-type items are accepted as Epic-equivalents. Single-item scores use the full schema (rationale, dependencies, harvest, questions). Bulk runs use lite mode (~60% fewer output tokens — just verdict, gate, reason, harvest target).</div>

    <div class="form-grid" style="grid-template-columns:120px 1fr">
      <label>Project</label>
      <select id="ing-project">${projectOpts}</select>
    </div>

    <div class="tab-row">
      <button data-tab="single" class="active">Single Epic</button>
      <button data-tab="bulk">Bulk JSON (lite)</button>
    </div>

    <div id="tab-single">
      <div class="form-grid">
        <label>Key *</label><input id="ing-key" placeholder="DSI-1234">
        <label>Summary *</label><input id="ing-summary" placeholder="Short summary">
        <label>Type *</label>
        <select id="ing-type">
          <option value="Epic" selected>Epic</option>
          <option value="Initiative">Initiative</option>
        </select>
        <label>Status</label><input id="ing-status" placeholder="In Progress / Backlog / Discovery">
        <label>Priority</label><input id="ing-priority" placeholder="High / Medium / Low">
        <label>Parent Initiative key *</label><input id="ing-parent-key" placeholder="AFIINIT-31 (required for Epics)">
        <label>Parent Initiative summary *</label><input id="ing-parent-sum" placeholder="e.g. Next-Gen Supply Chain Planning Transformation">
        <label>Labels</label><input id="ing-labels" placeholder="comma,separated">
        <label>Assignee</label><input id="ing-assignee">
        <label>Updated</label><input id="ing-updated" placeholder="2026-05-01 or 22d ago">
        <label>Description</label><textarea id="ing-desc" placeholder="Paste Epic description"></textarea>
      </div>
    </div>

    <div id="tab-bulk" style="display:none">
      <label class="eyebrow" style="display:block;margin:6px 0">Paste a JSON array of Epics (max 200). Each item must have <code>type: "Epic"</code> or <code>"Initiative"</code> — others are skipped. Required per item: <code>key</code>, <code>summary</code>, and <code>parent_key</code> (Epics only). <code>parent_summary</code> recommended. Bulk uses lite output mode.</label>
      <textarea id="ing-bulk" style="width:100%;min-height:180px;background:var(--bg3);border:1px solid var(--line);color:var(--hi);padding:10px;font:12px JetBrains Mono,monospace" placeholder='[{"key":"DSI-9001","summary":"...","type":"Epic","status":"Backlog","description":"..."}]'></textarea>
    </div>

    <div id="ing-output" class="ingest-output" style="display:none"></div>

    <div class="row">
      <button class="mini-btn" id="ing-cancel">Close</button>
      <button class="mini-btn primary" id="ing-submit" ${scorer.configured ? "" : "disabled"}>Score &amp; ingest</button>
    </div>
  `;
  modal.classList.add("open");

  const tabs = modalBody.querySelectorAll(".tab-row button");
  let activeTab = "single";
  tabs.forEach(t => t.addEventListener("click", () => {
    activeTab = t.dataset.tab;
    tabs.forEach(x => x.classList.toggle("active", x === t));
    modalBody.querySelector("#tab-single").style.display = activeTab === "single" ? "" : "none";
    modalBody.querySelector("#tab-bulk").style.display = activeTab === "bulk" ? "" : "none";
  }));

  // Initiatives don't need a parent — they ARE the parent. Disable those
  // inputs when the user picks Initiative.
  const typeSel = modalBody.querySelector("#ing-type");
  const pKey = modalBody.querySelector("#ing-parent-key");
  const pSum = modalBody.querySelector("#ing-parent-sum");
  const syncParentFields = () => {
    const isInit = typeSel.value === "Initiative";
    pKey.disabled = isInit; pSum.disabled = isInit;
    if (isInit) { pKey.value = ""; pSum.value = ""; }
    pKey.placeholder = isInit ? "(N/A for Initiative)" : "AFIINIT-31 (required for Epics)";
    pSum.placeholder = isInit ? "(N/A for Initiative)" : "e.g. Next-Gen Supply Chain Planning Transformation";
  };
  typeSel.addEventListener("change", syncParentFields);
  syncParentFields();

  modalBody.querySelector("#ing-cancel").addEventListener("click", () => { closeModal(); renderBu(bu.slug); });

  modalBody.querySelector("#ing-submit").addEventListener("click", async () => {
    const projectKey = modalBody.querySelector("#ing-project").value;
    const out = modalBody.querySelector("#ing-output");
    out.style.display = "block";

    let items;
    if (activeTab === "single") {
      const item = {
        key: modalBody.querySelector("#ing-key").value.trim(),
        summary: modalBody.querySelector("#ing-summary").value.trim(),
        type: modalBody.querySelector("#ing-type").value.trim(),
        status: modalBody.querySelector("#ing-status").value.trim(),
        priority: modalBody.querySelector("#ing-priority").value.trim(),
        parent_key: modalBody.querySelector("#ing-parent-key").value.trim(),
        parent_summary: modalBody.querySelector("#ing-parent-sum").value.trim(),
        labels: modalBody.querySelector("#ing-labels").value.split(",").map(s => s.trim()).filter(Boolean),
        assignee: modalBody.querySelector("#ing-assignee").value.trim(),
        updated: modalBody.querySelector("#ing-updated").value.trim(),
        description: modalBody.querySelector("#ing-desc").value.trim()
      };
      if (!item.key || !item.summary) { out.innerHTML = `<span class="err">Key and summary are required.</span>`; return; }
      if (item.type === "Epic" && !item.parent_key) {
        out.innerHTML = `<span class="err">Every Epic must link to a parent Initiative. Fill in the parent Initiative key (and summary), or change Type to Initiative.</span>`;
        return;
      }
      items = [item];
    } else {
      try {
        const parsed = JSON.parse(modalBody.querySelector("#ing-bulk").value);
        items = Array.isArray(parsed) ? parsed : [parsed];
      } catch (e) {
        out.innerHTML = `<span class="err">Invalid JSON: ${esc(e.message)}</span>`;
        return;
      }
    }

    out.innerHTML = `<span class="spinner"></span>Scoring ${items.length} item${items.length === 1 ? "" : "s"}…`;
    modalBody.querySelector("#ing-submit").disabled = true;

    try {
      let resp;
      if (items.length === 1) {
        resp = await api("POST", `/api/ingest/project/${encodeURIComponent(projectKey)}/single`, { item: items[0] });
        const r = resp.persisted;
        const verdict = resp.scored && resp.scored.verdict;
        out.innerHTML = r.skipped
          ? `<span class="skip">${esc(r.key)} skipped — ${esc(r.reason)}</span>`
          : `<span class="ok">${esc(r.key)} scored as <b>${esc(verdict)}</b></span>`;
      } else {
        resp = await api("POST", `/api/ingest/project/${encodeURIComponent(projectKey)}/bulk`, { items });
        out.innerHTML = resp.results.map(r => {
          if (!r.ok) return `<span class="err">${esc(r.key || "?")} failed — ${esc(r.error)}</span>`;
          if (r.skipped) return `<span class="skip">${esc(r.key)} skipped — ${esc(r.reason)}</span>`;
          return `<span class="ok">${esc(r.key)} → <b>${esc(r.verdict)}</b></span>`;
        }).join("\n");
      }
    } catch (e) {
      out.innerHTML = `<span class="err">${esc(e.message)}</span>`;
    } finally {
      modalBody.querySelector("#ing-submit").disabled = false;
    }
  });
}
