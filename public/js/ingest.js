// Ingest modal: single-form or bulk-JSON Epic ingestion through the scorer.

import { modal, modalBody, esc, api } from "./helpers.js";
import { closeModal } from "./modal.js";

export async function openIngestModal(bu, onDone) {
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

  // Initiatives don't need a parent — they ARE the parent.
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

  modalBody.querySelector("#ing-cancel").addEventListener("click", () => {
    closeModal();
    if (typeof onDone === "function") onDone();
  });

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
