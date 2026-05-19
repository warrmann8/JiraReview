// BU detail view: filters, project sections, item rows, decide actions.

import {
  VERDICTS, app, esc, api, verdictBar, getActor, saveActor, busInvalidate, getBus
} from "./helpers.js";
import { toast, toastOk, toastWarn, toastErr, toastWithAction } from "./toast.js";
import { openDecisionModal } from "./modal.js";
import { openIngestModal } from "./ingest.js";

const filterState = { verdict: null, status: null, project: null, gate: null, initiative: null, search: "", quick: null };

const QUICK_FILTERS = [
  { id: "decided",   label: "Decided",         match: it => !!it.override },
  { id: "ai-only",   label: "AI verdict only", match: it => !it.override },
  { id: "attention", label: "Needs attention", match: it => it.current_verdict === "FLAG" || (it.ai_meta && it.ai_meta.confidence === "low") },
  { id: "unlinked",  label: "Unlinked Epics",  match: it => !it.parent_key }
];

export async function renderBu(slug) {
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

  Object.assign(filterState, { verdict: null, status: null, project: null, gate: null, initiative: null, search: "", quick: null });

  // Pre-compute quick-filter membership per item so the chip counts and
  // applyFilters() both read off the same source of truth.
  for (const it of bu.projects.flatMap(p => p.items)) {
    it._qf = new Set();
    for (const q of QUICK_FILTERS) if (q.match(it)) it._qf.add(q.id);
  }

  document.getElementById("bu-body").innerHTML = renderBuHtml(bu);
  bindBuEvents(bu);
}

function renderBuHtml(bu) {
  const t = bu.tally;
  const projects = bu.projects
    .filter(p => p.items.length > 0)
    .sort((a, b) => b.items.length - a.items.length);
  const emptyProjects = bu.projects.filter(p => p.items.length === 0);
  const projectOpts = bu.projects.map(p => `<option value="${esc(p.key)}">${esc(p.key)} — ${esc(p.name)}</option>`).join("");
  const statuses = Array.from(new Set(bu.projects.flatMap(p => p.items.map(i => i.status).filter(Boolean)))).sort();
  const statusOpts = statuses.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");

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
    ${bu.scrubbed_by ? `<div class="eyebrow" style="margin-top:6px">Reviewed by ${esc(bu.scrubbed_by)} · ${esc(bu.scrubbed_date || "")}</div>` : ""}
    ${bu.bu_summary ? `<div class="summary">${esc(bu.bu_summary)}</div>` : ""}
    ${buEmptyHtml}
    <div class="metric-strip">
      <div class="metric"><div class="num">${t.total}</div><div class="label">Items scored</div></div>
      <div class="metric"><div class="num">${bu.projects.length}</div><div class="label">Projects</div></div>
      <div class="metric ${t.overrides ? "is-accent" : ""}"><div class="num">${t.overrides}</div><div class="label">Decisions made</div></div>
      <div class="metric ${bu.signoff ? "is-accent" : ""}">
        <div class="num">${bu.signoff ? "★" : "—"}</div>
        <div class="label">${bu.signoff ? `Signed off · ${esc(bu.signoff.actor || "")}` : "Not signed off"}</div>
        ${bu.signoff && bu.signoff.decided_at ? `<div class="sub-meta">${esc(new Date(bu.signoff.decided_at).toLocaleString())}</div>` : ""}
      </div>
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
        <a class="mini-btn" id="exportBu" href="/api/bu/${esc(bu.slug)}/export.html" target="_blank" rel="noopener" title="Download a self-contained HTML report">Export HTML</a>
        <a class="mini-btn" id="exportCsv" href="/api/bu/${esc(bu.slug)}/export.csv" title="Download decisions as CSV">Export CSV</a>
        <button class="mini-btn primary" id="ingestBu">Add items…</button>
        ${bu.signoff
          ? `<button class="mini-btn signoff-btn done" id="signoffBu" title="Signed off by ${esc(bu.signoff.actor)} · ${esc(new Date(bu.signoff.decided_at).toLocaleString())}">★ Signed off</button>`
          : `<button class="mini-btn signoff-btn" id="signoffBu" title="Mark this BU as reviewed">Sign off BU</button>`}
      </div>
    </div>
    ${emptyHtml}
    <div class="bulk-bar" id="bulk-bar">
      <span class="count"><b id="bulk-count">0</b>selected</span>
      <span class="spacer"></span>
      <span style="font:10px JetBrains Mono,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--mid)">Apply to all:</span>
      ${VERDICTS.map(v => `<button class="bulk-act ${v}" data-bulk="${v}">${v === "STOP" ? "Kill" : v}</button>`).join("")}
      <button class="bulk-clear" id="bulk-clear">Clear selection</button>
    </div>
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
            <th class="col-select"><input type="checkbox" class="select-all-check" data-project="${esc(p.key)}" aria-label="Select all"></th>
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
  const overridden = !!it.override;
  const decidedVerdict = overridden ? it.override.verdict : null;
  const aiVerdict = it.ai_verdict || "FLAG";
  const isDelta = overridden && decidedVerdict !== aiVerdict;
  const qfAttr = it._qf ? Array.from(it._qf).join(",") : "";
  const rowClass = [overridden ? "has-decision" : "", isDelta ? "is-delta" : ""].filter(Boolean).join(" ");
  const verdictCell = isDelta
    ? `<div class="verdict-delta">
         <span class="pill subtle ${esc(aiVerdict)}" title="AI verdict">${esc(aiVerdict)}</span>
         <span class="delta-arrow">→</span>
         <span class="pill ${esc(decidedVerdict)} is-override" title="Your decision${it.override.actor ? " · by " + esc(it.override.actor) : ""}">${esc(decidedVerdict)}</span>
       </div>
       ${it.override.actor ? `<div class="decided-by">decided · ${esc(it.override.actor)}</div>` : `<div class="decided-by">decided</div>`}`
    : `<span class="pill ${esc(it.current_verdict)} ${overridden ? "is-override" : ""}" title="${overridden ? "Your decision: " + esc(decidedVerdict) + (it.override.actor ? " · by " + esc(it.override.actor) : "") : ""}">${esc(it.current_verdict)}</span>
       ${overridden ? `<div class="decided-by">confirmed${it.override.actor ? ` · ${esc(it.override.actor)}` : ""}</div>` : ""}`;
  return `
    <tr class="${rowClass}" data-key="${esc(it.key)}" data-verdict="${esc(it.current_verdict)}" data-status="${esc(it.status || "")}" data-gate="${esc(it.ai_gate || "")}" data-project="${esc(it.project_key)}" data-initiative="${esc(it.parent_key || "__unlinked__")}" data-qf="${esc(qfAttr)}" data-overridden="${overridden ? "1" : "0"}" data-delta="${isDelta ? "1" : "0"}">
      <td><input type="checkbox" class="row-check" data-key="${esc(it.key)}" aria-label="Select ${esc(it.key)}" data-noopen></td>
      <td><a class="key" href="${esc(url)}" target="_blank" rel="noopener" data-noopen>${esc(it.key)}</a></td>
      <td>
        <div class="summary">${esc(it.summary || "")}${it.stale ? `<span class="stale-tag" title="Jira didn't return this item on the latest refresh. Decision history kept; review and clear if it's actually gone.">stale</span>` : ""}</div>
        ${it.parent_key
          ? `<div class="parent-tag">↳ <b>${esc(it.parent_key)}</b>${it.parent_summary ? " · " + esc(it.parent_summary) : ""}</div>`
          : `<div class="parent-tag unlinked">↳ no parent Initiative</div>`}
        ${it.child_evidence ? `<div class="child-evidence">${esc(it.child_evidence)}</div>` : ""}
      </td>
      <td>${esc(it.status || "")}</td>
      <td>${esc(it.priority || "")}</td>
      <td>${verdictCell}</td>
      <td>${it.ai_gate ? `<span class="gate">G${esc(it.ai_gate)}</span>` : ""}</td>
      <td>${esc(overridden ? it.override.reason || it.ai_reason : it.ai_reason || "")}</td>
      <td>
        <div class="actions">
          ${VERDICTS.map(v => {
            const isCurrent = decidedVerdict === v;
            return `<button class="act ${v}${isCurrent ? " is-current" : ""}" data-action="set" data-verdict="${v}" title="${isCurrent ? "Your current choice — " : "Set (shift-click to skip modal) — "}${v}">${v === "STOP" ? "Kill" : v}</button>`;
          }).join("")}
          <button class="act hist" data-action="open" title="Open decision modal">…</button>
        </div>
      </td>
    </tr>
  `;
}

function bindBuEvents(bu) {
  document.querySelectorAll(".rec-chip[data-verdict]").forEach(chip => {
    chip.addEventListener("click", () => {
      const v = chip.dataset.verdict;
      filterState.verdict = filterState.verdict === v ? null : v;
      document.querySelectorAll(".rec-chip[data-verdict]").forEach(c => c.classList.toggle("active", c.dataset.verdict === filterState.verdict));
      applyFilters();
    });
  });

  document.querySelectorAll(".qf").forEach(chip => {
    chip.addEventListener("click", () => {
      const id = chip.dataset.qf;
      filterState.quick = filterState.quick === id ? null : id;
      document.querySelectorAll(".qf").forEach(c => c.classList.toggle("active", c.dataset.qf === filterState.quick));
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
    catch { /* fall through */ }
    finally { clearLoading(e.target); }
    renderBu(bu.slug);
  });

  document.getElementById("ingestBu").addEventListener("click", () => openIngestModal(bu, () => renderBu(bu.slug)));
  const ingestEmpty = document.getElementById("ingestEmptyBu");
  if (ingestEmpty) ingestEmpty.addEventListener("click", () => openIngestModal(bu, () => renderBu(bu.slug)));

  document.getElementById("signoffBu").addEventListener("click", async () => {
    if (bu.signoff) {
      if (!confirm(`Revoke the sign-off on ${bu.name}? It was signed off by ${bu.signoff.actor} on ${new Date(bu.signoff.decided_at).toLocaleString()}.`)) return;
      try {
        await api("DELETE", `/api/bu/${encodeURIComponent(bu.slug)}/signoff`);
        toastOk("Sign-off revoked");
        busInvalidate();
        getBus().catch(() => {});
        renderBu(bu.slug);
      } catch (e) { toastErr("Revoke failed: " + e.message); }
      return;
    }
    const undecided = t.total - t.overrides;
    const proceed = confirm(`Sign off ${bu.name}?\n\n${t.overrides} of ${t.total} Epics decided.${undecided > 0 ? `\n${undecided} still on the AI verdict — that's fine, sign-off just records "I've reviewed."` : ""}\n\nYou can revoke later.`);
    if (!proceed) return;
    const summary = prompt(`Optional sign-off summary (visible in audit log + export):`, "");
    if (summary === null) return;
    saveActor();
    try {
      await api("POST", `/api/bu/${encodeURIComponent(bu.slug)}/signoff`, {
        summary, actor: getActor()
      });
      toastOk(`${bu.name} signed off`, { duration: 4000 });
      busInvalidate();
      getBus().catch(() => {});
      renderBu(bu.slug);
    } catch (e) { toastErr("Sign-off failed: " + e.message); }
  });

  document.querySelectorAll(".refresh-proj").forEach(b => {
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      setLoading(b, "Refreshing");
      try { await api("POST", `/api/refresh/project/${encodeURIComponent(b.dataset.key)}`); }
      catch { /* */ }
      finally { clearLoading(b); }
      renderBu(bu.slug);
    });
  });

  document.querySelectorAll("[data-reset-filters]").forEach(b => {
    b.addEventListener("click", () => document.getElementById("resetFilters").click());
  });

  document.querySelectorAll(".project header.proj").forEach(h => {
    h.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.closest("a")) return;
      h.parentElement.classList.toggle("collapsed");
    });
  });

  // Row actions: click anywhere on the row (except the Jira-link, the
  // bulk-checkbox, or the hover-revealed verdict buttons) to open the
  // decision modal. SHIFT-click on a verdict button = quick-decide
  // (skip modal, log with empty reason).
  document.querySelectorAll("table.items tbody tr").forEach(tr => {
    tr.addEventListener("click", (e) => {
      const key = tr.dataset.key;
      const btn = e.target.closest("button[data-action]");
      if (btn) {
        if (btn.dataset.action === "set") {
          // Shift-click on STOP requires a quick confirm — Hard Rule #2
          // says never STOP a Gate 1 item, so a misclick here can be
          // costly. KEEP/FOLD/FLAG go straight through; STOP gets a
          // single confirm dialog.
          if (e.shiftKey) {
            if (btn.dataset.verdict === "STOP" &&
                !confirm("Kill (STOP) this Epic without opening the modal?\n\nFramework Hard Rule #2: never STOP a Gate 1 item. Click Cancel to open the modal and review the AI rationale first.")) {
              return;
            }
            return quickDecide(key, btn.dataset.verdict, bu);
          }
          openDecisionModal(key, btn.dataset.verdict, bu);
        } else if (btn.dataset.action === "open") {
          openDecisionModal(key, null, bu);
        }
        return;
      }
      if (e.target.closest("[data-noopen]")) return;
      openDecisionModal(key, null, bu);
    });
  });

  const bulkBar = document.getElementById("bulk-bar");
  const bulkCount = document.getElementById("bulk-count");
  const bulkClear = document.getElementById("bulk-clear");
  const updateBulkBar = () => {
    const checked = document.querySelectorAll(".row-check:checked").length;
    bulkCount.textContent = checked;
    bulkBar.classList.toggle("is-active", checked > 0);
  };
  document.querySelectorAll(".row-check").forEach(cb => {
    cb.addEventListener("click", e => e.stopPropagation());
    cb.addEventListener("change", updateBulkBar);
  });
  document.querySelectorAll(".select-all-check").forEach(master => {
    master.addEventListener("click", e => e.stopPropagation());
    master.addEventListener("change", () => {
      const proj = master.dataset.project;
      document.querySelectorAll(`.project[data-project="${CSS.escape(proj)}"] .row-check`).forEach(cb => {
        const row = cb.closest("tr");
        if (row && row.style.display !== "none") cb.checked = master.checked;
      });
      updateBulkBar();
    });
  });
  bulkClear.addEventListener("click", () => {
    document.querySelectorAll(".row-check:checked,.select-all-check:checked").forEach(c => (c.checked = false));
    updateBulkBar();
  });
  document.querySelectorAll(".bulk-act").forEach(b => {
    b.addEventListener("click", () => bulkDecide(b.dataset.bulk, bu));
  });

  applyFilters();
}

// Keyboard nav while on a BU page:
//   /     focuses the BU search
//   j/k   move between visible rows
//   x     toggle row checkbox (for bulk select)
//   enter open the focused row in the decision modal
document.addEventListener("keydown", (e) => {
  const t = e.target;
  const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
  if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!location.hash.startsWith("#/bu/")) return;

  if (e.key === "/") {
    const q = document.getElementById("f-q");
    if (q) { e.preventDefault(); q.focus(); q.select(); }
    return;
  }
  if (e.key !== "j" && e.key !== "k" && e.key !== "x" && e.key !== "Enter") return;

  const rows = Array.from(document.querySelectorAll("table.items tbody tr"))
    .filter(r => r.style.display !== "none");
  if (rows.length === 0) return;
  const cur = rows.findIndex(r => r.classList.contains("kbd-cursor"));

  if (e.key === "j" || e.key === "k") {
    e.preventDefault();
    const next = Math.max(0, Math.min(rows.length - 1,
      cur === -1 ? 0 : cur + (e.key === "j" ? 1 : -1)));
    rows.forEach(r => r.classList.remove("kbd-cursor"));
    rows[next].classList.add("kbd-cursor");
    rows[next].scrollIntoView({ block: "center", behavior: "smooth" });
  } else if (e.key === "x" && cur !== -1) {
    e.preventDefault();
    const cb = rows[cur].querySelector(".row-check");
    if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change", { bubbles: true })); }
  } else if (e.key === "Enter" && cur !== -1) {
    e.preventDefault();
    rows[cur].click();
  }
});

async function quickDecide(key, verdict, bu) {
  saveActor();
  let priorOverride = null;
  // Capture the prior state so Undo can restore it (clear if the item had
  // no prior decision; reapply the prior verdict if it did).
  try {
    const pre = await api("GET", `/api/item/${encodeURIComponent(key)}`);
    priorOverride = pre && pre.item && pre.item.override ? pre.item.override : null;
  } catch { /* best effort */ }

  try {
    await api("POST", "/api/decision", { key, verdict, reason: "", actor: getActor() });
    toastWithAction(`${key} → ${verdict}`, "Undo", () => undoDecision(key, priorOverride, bu), { duration: 5000 });
    busInvalidate();
    getBus().catch(() => {});
    renderBu(bu.slug);
  } catch (e) {
    toastErr("Save failed: " + e.message);
  }
}

async function undoDecision(key, priorOverride, bu) {
  try {
    if (priorOverride) {
      await api("POST", "/api/decision", {
        key, verdict: priorOverride.verdict, reason: priorOverride.reason || "",
        actor: getActor()
      });
      toastOk(`Restored prior decision · ${priorOverride.verdict}`, { duration: 2500 });
    } else {
      await api("DELETE", `/api/decision/${encodeURIComponent(key)}`, { actor: getActor() });
      toastOk(`Cleared · ${key}`, { duration: 2500 });
    }
    busInvalidate();
    getBus().catch(() => {});
    renderBu(bu.slug);
  } catch (e) {
    toastErr("Undo failed: " + e.message);
  }
}

async function bulkDecide(verdict, bu) {
  const checkedRows = Array.from(document.querySelectorAll(".row-check:checked")).map(c => c.closest("tr"));
  const keys = checkedRows.map(r => r.dataset.key);
  if (keys.length === 0) return;
  const reason = prompt(`Apply ${verdict} to ${keys.length} Epic${keys.length === 1 ? "" : "s"}.\n\nOptional reason (will apply to all):`);
  if (reason === null) return;
  saveActor();
  const actor = getActor();
  let ok = 0, fail = 0;
  const dismissProgress = toast(`Saving ${keys.length}…`, { duration: 0 });
  for (const key of keys) {
    try {
      await api("POST", "/api/decision", { key, verdict, reason: reason || "", actor });
      ok++;
    } catch {
      fail++;
    }
  }
  dismissProgress();
  if (fail === 0) toastOk(`Decided ${ok} Epic${ok === 1 ? "" : "s"} → ${verdict}`);
  else toastWarn(`Decided ${ok}, failed ${fail}`);

  // Pattern suggestion: if the user just bulk-decided several Epics that
  // share a parent Initiative or AI verdict, surface remaining undecided
  // siblings as candidates for the same treatment.
  const suggestion = findPatternCandidates(checkedRows, verdict);

  busInvalidate();
  getBus().catch(() => {});
  renderBu(bu.slug);

  if (suggestion && suggestion.candidateKeys.length >= 2) {
    setTimeout(() => offerPatternApply(suggestion, verdict, reason || "", bu), 350);
  }
}

// Look at the just-decided rows. If they share a parent_key or ai_verdict,
// return the list of remaining (still undecided) rows that match that
// signal — these are likely candidates for the same bulk decision.
function findPatternCandidates(decidedRows, verdict) {
  if (decidedRows.length < 2) return null;
  const parents = new Set();
  const aiVerdicts = new Set();
  for (const r of decidedRows) {
    if (r.dataset.initiative && r.dataset.initiative !== "__unlinked__") parents.add(r.dataset.initiative);
    aiVerdicts.add(r.dataset.verdict); // current_verdict at render time
  }
  // Strongest signal: shared parent Initiative.
  let sharedParent = null;
  if (parents.size === 1) sharedParent = [...parents][0];
  let sharedAi = null;
  if (aiVerdicts.size === 1) sharedAi = [...aiVerdicts][0];
  if (!sharedParent && !sharedAi) return null;

  const allRows = Array.from(document.querySelectorAll("table.items tbody tr"));
  const candidates = allRows.filter(r => {
    if (r.dataset.overridden === "1") return false; // already decided
    if (decidedRows.includes(r)) return false;
    if (r.style.display === "none") return false;
    if (sharedParent && r.dataset.initiative !== sharedParent) return false;
    if (sharedAi && r.dataset.verdict !== sharedAi) return false;
    return true;
  });
  return {
    sharedParent, sharedAi,
    candidateKeys: candidates.map(r => r.dataset.key),
    candidateRows: candidates
  };
}

function offerPatternApply(sig, verdict, reason, bu) {
  const why = sig.sharedParent
    ? `Other Epics under ${sig.sharedParent}`
    : `Other Epics with AI verdict ${sig.sharedAi}`;
  toastWithAction(
    `${why} — ${sig.candidateKeys.length} look similar. Apply ${verdict} to those too?`,
    `Apply ${verdict} to ${sig.candidateKeys.length}`,
    async () => {
      saveActor();
      const actor = getActor();
      let ok = 0, fail = 0;
      const dismiss = toast(`Saving ${sig.candidateKeys.length}…`, { duration: 0 });
      for (const key of sig.candidateKeys) {
        try { await api("POST", "/api/decision", { key, verdict, reason, actor }); ok++; }
        catch { fail++; }
      }
      dismiss();
      if (fail === 0) toastOk(`Decided ${ok} more · ${verdict}`);
      else toastWarn(`Decided ${ok}, failed ${fail}`);
      busInvalidate();
      getBus().catch(() => {});
      renderBu(bu.slug);
    },
    { duration: 12000, title: "Bulk pattern detected" }
  );
}

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

  const filtering = !!(filterState.verdict || filterState.status || filterState.gate || filterState.project || filterState.initiative || filterState.quick || filterState.search);
  document.querySelectorAll(".project").forEach(sec => {
    const visible = sec.querySelectorAll("table.items tbody tr:not([style*='display: none'])").length;
    sec.style.display = visible === 0 ? "none" : "";
    if (filtering && visible > 0) sec.classList.remove("collapsed");
  });

  const fc = document.getElementById("filter-count");
  if (fc) {
    fc.innerHTML = filtering ? `<b>${shown}</b> of ${total} shown` : `${total} Epics`;
  }
  const empty = document.getElementById("empty-filter");
  if (empty) empty.style.display = (filtering && shown === 0) ? "" : "none";
}
