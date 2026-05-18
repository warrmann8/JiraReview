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
window.addEventListener("DOMContentLoaded", route);

function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  if (hash.startsWith("/bu/")) renderBu(hash.slice(4));
  else renderLanding();
}

refreshAllBtn.addEventListener("click", async () => {
  refreshAllBtn.textContent = "Refreshing...";
  try {
    await api("POST", "/api/refresh");
    route();
  } finally {
    refreshAllBtn.textContent = "Refresh all";
  }
});

// ---- landing: list of BUs ----
async function renderLanding() {
  app.innerHTML = `<div class="eyebrow">17 business units · 91 projects</div>
    <h2 style="margin-top:8px">Business units</h2>
    <div class="sub" style="color:var(--mid);margin:6px 0 18px;font-size:14px">Each tile is a BU. Populated tiles have scored items ready to review. Empty tiles are placeholders ready for their scrub HTML to be added.</div>
    <div class="bu-grid" id="bu-grid"></div>`;
  let data;
  try { data = await api("GET", "/api/bus"); }
  catch (e) { app.innerHTML += `<div class="note">Could not load BUs: ${esc(e.message)}</div>`; return; }
  generatedEl.textContent = `seed: ${data.generated_at ? new Date(data.generated_at).toLocaleString() : "—"}`;

  const grid = document.getElementById("bu-grid");
  for (const bu of data.bus) {
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
const filterState = { verdict: null, status: null, project: null, gate: null, search: "" };

async function renderBu(slug) {
  app.innerHTML = `<div class="crumb"><a href="#/">all business units</a> / <span id="cur"></span></div>
    <div id="bu-body">Loading…</div>`;
  let bu;
  try { bu = await api("GET", `/api/bu/${encodeURIComponent(slug)}`); }
  catch (e) { document.getElementById("bu-body").innerHTML = `<div class="note">Could not load BU: ${esc(e.message)}</div>`; return; }
  document.getElementById("cur").textContent = bu.name;
  generatedEl.textContent = bu.scrubbed_date ? `scrub: ${bu.scrubbed_date}` : `not yet scrubbed`;

  Object.assign(filterState, { verdict: null, status: null, project: null, gate: null, search: "" });

  document.getElementById("bu-body").innerHTML = renderBuHtml(bu);
  bindBuEvents(bu);
}

function renderBuHtml(bu) {
  const t = bu.tally;
  const projects = bu.projects.filter(p => p.items.length > 0);
  const emptyProjects = bu.projects.filter(p => p.items.length === 0);
  const projectOpts = bu.projects.map(p => `<option value="${esc(p.key)}">${esc(p.key)} — ${esc(p.name)}</option>`).join("");
  const statuses = Array.from(new Set(bu.projects.flatMap(p => p.items.map(i => i.status).filter(Boolean)))).sort();
  const statusOpts = statuses.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");

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
    ? `<div class="note"><b>${emptyProjects.length} project${emptyProjects.length === 1 ? "" : "s"}</b> in this BU have no scored items yet: ${emptyProjects.map(p => `<code>${esc(p.key)}</code>`).join(" ")}. Drop a scrub HTML for these projects and re-seed to populate.</div>`
    : "";

  const buEmptyHtml = bu.item_count === 0
    ? `<div class="note"><b>${esc(bu.name)} has no scored items yet.</b> Add a scrub HTML for one of its projects and run <code>npm run seed</code> to populate this BU.</div>`
    : "";

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
    <div class="toolbar">
      <div class="filters">
        <select id="f-project"><option value="">All projects</option>${projectOpts}</select>
        <select id="f-status"><option value="">All statuses</option>${statusOpts}</select>
        <select id="f-gate"><option value="">All gates</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select>
        <input class="q" id="f-q" placeholder="search key / summary / reason" size="34">
      </div>
      <div class="filters">
        <button class="mini-btn" id="resetFilters">Reset</button>
        <button class="mini-btn" id="refreshBu">Refresh BU</button>
      </div>
    </div>
    ${emptyHtml}
    <div id="projects">${projects.map(renderProject).join("")}</div>
    ${signalsHtml}
    ${questionsHtml}
  `;
}

function renderProject(p) {
  const tally = p.items.reduce((a, i) => { a[i.current_verdict] = (a[i.current_verdict] || 0) + 1; a.total++; return a; }, { KEEP: 0, STOP: 0, FOLD: 0, FLAG: 0, total: 0 });
  return `
    <section class="project" data-project="${esc(p.key)}">
      <header class="proj">
        <div class="proj-left">
          <span class="pkey">${esc(p.key)}</span>
          <span class="pname">${esc(p.name)}</span>
          <span class="pcat">${esc(p.category)}</span>
        </div>
        <div class="proj-right">
          <span class="pcount">${p.items.length} items</span>
          ${verdictBar(tally)}
          <button class="mini-btn refresh-proj" data-key="${esc(p.key)}">Refresh</button>
        </div>
      </header>
      <div class="body">
        <table class="items">
          <thead><tr>
            <th class="col-key">Key</th>
            <th class="col-summary">Summary</th>
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
  return `
    <tr data-key="${esc(it.key)}" data-verdict="${esc(it.current_verdict)}" data-status="${esc(it.status || "")}" data-gate="${esc(it.ai_gate || "")}" data-project="${esc(it.project_key)}">
      <td><a class="key" href="${esc(url)}" target="_blank" rel="noopener">${esc(it.key)}</a></td>
      <td>
        <div class="summary">${esc(it.summary || "")}</div>
        ${it.parent_key ? `<div class="parent-tag">↳ ${esc(it.parent_key)} · ${esc(it.parent_summary || "")}</div>` : ""}
        ${it.child_evidence ? `<div class="child-evidence">${esc(it.child_evidence)}</div>` : ""}
      </td>
      <td>${esc(it.status || "")}</td>
      <td>${esc(it.priority || "")}</td>
      <td><span class="pill ${esc(it.current_verdict)}">${esc(it.current_verdict)}</span>${dot}</td>
      <td>${it.ai_gate ? `<span class="gate">G${esc(it.ai_gate)}</span>` : ""}</td>
      <td>${esc(it.override ? it.override.reason || it.ai_reason : it.ai_reason || "")}</td>
      <td>
        <div class="actions">
          ${VERDICTS.map(v => `<button class="act ${v}" data-action="set" data-verdict="${v}">${v === "STOP" ? "Kill" : v}</button>`).join("")}
          <button class="act hist" data-action="open">…</button>
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

  const fProj = document.getElementById("f-project");
  const fStatus = document.getElementById("f-status");
  const fGate = document.getElementById("f-gate");
  const fQ = document.getElementById("f-q");
  fProj.addEventListener("change", () => { filterState.project = fProj.value || null; applyFilters(); });
  fStatus.addEventListener("change", () => { filterState.status = fStatus.value || null; applyFilters(); });
  fGate.addEventListener("change", () => { filterState.gate = fGate.value || null; applyFilters(); });
  fQ.addEventListener("input", () => { filterState.search = fQ.value.toLowerCase(); applyFilters(); });
  document.getElementById("resetFilters").addEventListener("click", () => {
    Object.assign(filterState, { verdict: null, status: null, project: null, gate: null, search: "" });
    fProj.value = ""; fStatus.value = ""; fGate.value = ""; fQ.value = "";
    document.querySelectorAll(".rec-chip[data-verdict]").forEach(c => c.classList.remove("active"));
    applyFilters();
  });

  document.getElementById("refreshBu").addEventListener("click", async (e) => {
    e.target.textContent = "Refreshing...";
    try { await api("POST", `/api/refresh/bu/${encodeURIComponent(bu.slug)}`); }
    finally { e.target.textContent = "Refresh BU"; }
    renderBu(bu.slug);
  });

  document.querySelectorAll(".refresh-proj").forEach(b => {
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const k = b.dataset.key;
      b.textContent = "...";
      try { await api("POST", `/api/refresh/project/${encodeURIComponent(k)}`); }
      finally { b.textContent = "Refresh"; }
      renderBu(bu.slug);
    });
  });

  // Collapse project sections
  document.querySelectorAll(".project header.proj").forEach(h => {
    h.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.closest("a")) return;
      h.parentElement.classList.toggle("collapsed");
    });
  });

  // Row actions
  document.querySelectorAll("table.items tbody tr").forEach(tr => {
    tr.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const key = tr.dataset.key;
      if (btn.dataset.action === "set") {
        // Quick-set: opens modal pre-filled to confirm reason
        openDecisionModal(key, btn.dataset.verdict, bu);
      } else if (btn.dataset.action === "open") {
        openDecisionModal(key, null, bu);
      }
    });
  });

  applyFilters();
}

function applyFilters() {
  const rows = document.querySelectorAll("table.items tbody tr");
  rows.forEach(tr => {
    const v = tr.dataset.verdict;
    const s = tr.dataset.status;
    const g = tr.dataset.gate;
    const p = tr.dataset.project;
    const text = tr.textContent.toLowerCase();
    let show = true;
    if (filterState.verdict && v !== filterState.verdict) show = false;
    if (filterState.status && s !== filterState.status) show = false;
    if (filterState.gate && String(g) !== String(filterState.gate)) show = false;
    if (filterState.project && p !== filterState.project) show = false;
    if (filterState.search && !text.includes(filterState.search)) show = false;
    tr.style.display = show ? "" : "none";
  });
  // Hide project sections with zero visible rows
  document.querySelectorAll(".project").forEach(sec => {
    const visible = sec.querySelectorAll("table.items tbody tr:not([style*='display: none'])").length;
    sec.style.display = visible === 0 ? "none" : "";
  });
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
      ${VERDICTS.map(v => `<button data-v="${v}" class="${v === chosen ? "selected" : ""}">${v === "STOP" ? "STOP / KILL" : v}</button>`).join("")}
    </div>

    <label>Reason (optional but recommended)</label>
    <textarea id="reason" placeholder="Why this verdict? Cite the gate.">${esc(item.override ? item.override.reason : "")}</textarea>

    <div class="row">
      ${item.override ? `<button class="mini-btn" id="clear">Clear override</button>` : ""}
      <button class="mini-btn" id="cancel">Cancel</button>
      <button class="mini-btn primary" id="save">Save decision</button>
    </div>

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

  modalBody.querySelectorAll("#v-row button").forEach(b => {
    b.addEventListener("click", () => {
      chosen = b.dataset.v;
      modalBody.querySelectorAll("#v-row button").forEach(x => x.classList.toggle("selected", x.dataset.v === chosen));
    });
  });
  modalBody.querySelector("#cancel").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); }, { once: true });

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
