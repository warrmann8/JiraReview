// AI rules editor: edit the system prompt the LLM uses to score Epics.
// Saves snapshot previous version to prompts/history/.

import { app, esc, api, modal, modalBody } from "./helpers.js";
import { toastErr, toastOk, toast } from "./toast.js";

async function openRescorePicker() {
  let bus;
  try { bus = await api("GET", "/api/bus"); }
  catch (e) { toastErr("Could not load BUs: " + e.message); return; }
  const populated = bus.bus.filter(b => b.item_count > 0);

  const projectsBySlug = {};
  for (const bu of populated) {
    try {
      const detail = await api("GET", `/api/bu/${encodeURIComponent(bu.slug)}`);
      projectsBySlug[bu.slug] = { name: bu.name, projects: detail.projects.filter(p => p.items.length > 0) };
    } catch { /* skip */ }
  }

  const opts = Object.entries(projectsBySlug).flatMap(([slug, info]) =>
    info.projects.map(p => `<option value="${esc(p.key)}" data-bu="${esc(slug)}" data-bu-name="${esc(info.name)}">${esc(info.name)} → ${esc(p.key)} ${esc(p.name)} (${p.items.length})</option>`)
  ).join("");

  modalBody.innerHTML = `
    <h3>Re-score with current rules</h3>
    <div class="ai-line">Runs the AI scorer over every Epic in the chosen project using the rules currently saved. <b>Human decisions are not touched</b> — only the AI verdict, gate, reason, and metadata are rewritten. Cost scales with the number of items.</div>

    <label style="margin-top:14px;display:block">Project</label>
    <select id="rs-project" style="width:100%;background:var(--bg3);border:1px solid var(--line);color:var(--hi);padding:9px 11px;font:12px JetBrains Mono,monospace">
      ${opts}
    </select>

    <label style="margin-top:14px;display:block">Output detail</label>
    <div class="verdict-row" id="rs-mode">
      <button data-mode="lite" class="selected">Lite (cheaper)</button>
      <button data-mode="full">Full (rationale + dependencies)</button>
    </div>

    <div id="rs-output" class="ingest-output" style="display:none"></div>

    <div class="row">
      <button class="mini-btn" id="rs-cancel">Cancel</button>
      <button class="mini-btn primary" id="rs-run">Re-score project</button>
    </div>
  `;
  modal.classList.add("open");

  let mode = "lite";
  modalBody.querySelectorAll("#rs-mode button").forEach(b => {
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      modalBody.querySelectorAll("#rs-mode button").forEach(x => x.classList.toggle("selected", x === b));
    });
  });
  modalBody.querySelector("#rs-cancel").addEventListener("click", () => { modal.classList.remove("open"); modalBody.innerHTML = ""; });

  modalBody.querySelector("#rs-run").addEventListener("click", async () => {
    const sel = modalBody.querySelector("#rs-project");
    const projectKey = sel.value;
    const buName = sel.selectedOptions[0]?.dataset.buName || "";
    if (!confirm(`Re-score every Epic in ${buName} → ${projectKey}? This calls the LLM once per Epic and may take a minute.`)) return;

    const out = modalBody.querySelector("#rs-output");
    out.style.display = "block";
    out.innerHTML = `<span class="spinner"></span> Re-scoring…`;
    modalBody.querySelector("#rs-run").disabled = true;
    try {
      const resp = await api("POST", `/api/rescore/project/${encodeURIComponent(projectKey)}`, { mode });
      const ok = resp.results.filter(r => r.ok && !r.skipped).length;
      const changed = resp.changed;
      const skipped = resp.results.filter(r => r.skipped).length;
      const fail = resp.results.filter(r => !r.ok).length;
      out.innerHTML = resp.results.map(r => {
        if (!r.ok) return `<span class="err">${esc(r.key)} failed — ${esc(r.error)}</span>`;
        if (r.skipped) return `<span class="skip">${esc(r.key)} skipped — ${esc(r.reason)}</span>`;
        const verdictChange = r.changed ? ` <b>(was ${esc(r.prior_verdict)})</b>` : ` (unchanged)`;
        return `<span class="${r.changed ? "ok" : "skip"}">${esc(r.key)} → ${esc(r.verdict)}${verdictChange}</span>`;
      }).join("\n");
      toastOk(`Re-scored ${ok} Epic${ok === 1 ? "" : "s"} · ${changed} changed${fail ? ` · ${fail} failed` : ""}${skipped ? ` · ${skipped} skipped` : ""}`, { duration: 5500 });
    } catch (e) {
      out.innerHTML = `<span class="err">${esc(e.message)}</span>`;
      toastErr("Re-score failed: " + e.message);
    } finally {
      modalBody.querySelector("#rs-run").disabled = false;
    }
  });
}

export async function renderPromptEditor() {
  app.innerHTML = `<div class="crumb">
      <a href="#/">Portfolio</a>
      <span class="crumb-sep">›</span>
      <span id="cur">AI evaluation rules</span>
    </div>
    <div id="prompt-body">Loading…</div>`;

  let data, history;
  try {
    data = await api("GET", "/api/prompt");
    history = await api("GET", "/api/prompt/history");
  } catch (e) {
    document.getElementById("prompt-body").innerHTML = `<div class="note">Could not load prompt: ${esc(e.message)}</div>`;
    return;
  }

  document.getElementById("prompt-body").innerHTML = `
    <h1 style="margin:6px 0 14px">AI evaluation rules</h1>
    <div class="summary">This is the system prompt the LLM uses to score every Jira Epic. Editing here changes how all future scores are generated — existing scored Epics are not re-evaluated. Every save snapshots the prior version so you can roll back.</div>

    <div class="metric-strip" style="margin-top:18px">
      <div class="metric"><div class="num" id="p-bytes">${data.bytes}</div><div class="label">Bytes</div></div>
      <div class="metric"><div class="num" id="p-tokens">~${data.approx_tokens}</div><div class="label">Approx tokens</div></div>
      <div class="metric"><div class="num" id="p-saved" style="font-size:18px">${esc(new Date(data.updated_at).toLocaleString())}</div><div class="label">Last saved</div></div>
      <div class="metric"><div class="num">${history.history.length}</div><div class="label">Snapshots</div></div>
    </div>

    <div class="prompt-actions">
      <button class="mini-btn" id="p-revert" title="Discard unsaved changes">Discard changes</button>
      <button class="mini-btn" id="p-toggle-history">View history (${history.history.length})</button>
      <button class="mini-btn" id="p-rescore" title="Re-run the AI scorer with these rules across an existing project. Human decisions are not touched.">Re-score a project…</button>
      <span style="flex:1"></span>
      <span id="p-dirty" class="dirty-tag" style="display:none">Unsaved changes</span>
      <button class="mini-btn primary" id="p-save">Save rules</button>
    </div>

    <textarea id="p-editor" class="prompt-editor" spellcheck="false">${esc(data.content)}</textarea>

    <div id="p-history" class="history-panel" style="display:none"></div>
  `;

  const editor = document.getElementById("p-editor");
  const saveBtn = document.getElementById("p-save");
  const revertBtn = document.getElementById("p-revert");
  const dirty = document.getElementById("p-dirty");
  const bytesEl = document.getElementById("p-bytes");
  const tokensEl = document.getElementById("p-tokens");
  let original = data.content;

  const updateMetrics = () => {
    const len = editor.value.length;
    bytesEl.textContent = len;
    tokensEl.textContent = "~" + Math.round(len / 4);
    const isDirty = editor.value !== original;
    dirty.style.display = isDirty ? "" : "none";
    saveBtn.disabled = !isDirty;
  };
  editor.addEventListener("input", updateMetrics);
  updateMetrics();

  revertBtn.addEventListener("click", () => {
    if (editor.value === original) return;
    if (!confirm("Discard your unsaved changes and revert to the last saved version?")) return;
    editor.value = original;
    updateMetrics();
  });

  saveBtn.addEventListener("click", async () => {
    if (!confirm("Save these rules? This affects every future LLM score. A snapshot of the previous version will be kept.")) return;
    saveBtn.disabled = true;
    saveBtn.dataset.orig = saveBtn.textContent;
    saveBtn.innerHTML = `<span class="spinner-sm"></span> Saving`;
    try {
      const resp = await api("PUT", "/api/prompt", { content: editor.value });
      original = editor.value;
      bytesEl.textContent = resp.bytes;
      tokensEl.textContent = "~" + resp.approx_tokens;
      dirty.style.display = "none";
      saveBtn.textContent = saveBtn.dataset.orig || "Save rules";
      saveBtn.disabled = false;
      renderPromptEditor();
    } catch (e) {
      toastErr("Save failed: " + e.message);
      saveBtn.textContent = saveBtn.dataset.orig || "Save rules";
      saveBtn.disabled = false;
    }
  });

  const navGuard = (e) => {
    if (editor.value !== original) {
      e.preventDefault();
      e.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", navGuard);

  document.getElementById("p-rescore").addEventListener("click", () => openRescorePicker());

  document.getElementById("p-toggle-history").addEventListener("click", async () => {
    const panel = document.getElementById("p-history");
    if (panel.style.display !== "none") { panel.style.display = "none"; return; }
    panel.innerHTML = `<h3 style="margin-top:18px">Snapshots</h3><div class="sub" style="color:var(--mid);font-size:13px;margin-bottom:10px">Last 20 saved versions. Click to preview; click "Restore" to copy back into the editor (you still need to Save to make it live).</div>` +
      history.history.map(h => `
        <div class="hist-row" data-name="${esc(h.name)}">
          <span class="hist-when">${esc(new Date(h.saved_at).toLocaleString())}</span>
          <span class="hist-name">${esc(h.name)}</span>
          <span class="hist-bytes">${h.bytes} B</span>
          <button class="mini-btn hist-preview" data-name="${esc(h.name)}">Preview</button>
          <button class="mini-btn hist-restore" data-name="${esc(h.name)}">Restore</button>
        </div>
      `).join("") +
      `<div id="hist-preview-pane" style="display:none"></div>`;
    panel.style.display = "";

    panel.querySelectorAll(".hist-preview").forEach(b => {
      b.addEventListener("click", async () => {
        const r = await api("GET", `/api/prompt/history/${encodeURIComponent(b.dataset.name)}`);
        const pane = document.getElementById("hist-preview-pane");
        pane.style.display = "";
        pane.innerHTML = `<div class="eyebrow" style="margin-top:14px">${esc(b.dataset.name)}</div><pre class="hist-preview-pre">${esc(r.content)}</pre>`;
      });
    });
    panel.querySelectorAll(".hist-restore").forEach(b => {
      b.addEventListener("click", async () => {
        if (!confirm(`Replace the editor contents with ${b.dataset.name}? You'll still need to Save to make it live.`)) return;
        const r = await api("GET", `/api/prompt/history/${encodeURIComponent(b.dataset.name)}`);
        const cleaned = r.content.replace(/^<!--[^\n]*-->\n/, "");
        editor.value = cleaned;
        updateMetrics();
      });
    });
  });
}
