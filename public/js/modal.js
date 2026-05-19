// Decision modal: per-item verdict + reason + AI metadata + history.

import {
  VERDICTS, modal, modalBody, esc, fmtDate, api, getActor, saveActor, busInvalidate, getBus
} from "./helpers.js";
import { toastErr, toastWarn } from "./toast.js";

let rerender = () => {};
export function setModalRerender(fn) { rerender = fn || (() => {}); }

export function closeModal() {
  modal.classList.remove("open");
  modalBody.innerHTML = "";
}
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

export async function openDecisionModal(key, preselect, bu) {
  let payload;
  try { payload = await api("GET", `/api/item/${encodeURIComponent(key)}`); }
  catch (e) { toastErr("Could not load item: " + e.message); return; }
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
        const k = v[0];
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

  // Keyboard: K/S/F/L pick verdict, Cmd/Ctrl+Enter saves. Skip while
  // typing in the reason textarea so single letters work normally there.
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

  saveBtn.addEventListener("click", async () => {
    if (!chosen) { toastWarn("Pick a verdict."); return; }
    saveActor();
    try {
      await api("POST", "/api/decision", {
        key: item.key,
        verdict: chosen,
        reason: modalBody.querySelector("#reason").value.trim(),
        actor: getActor()
      });
      closeModal();
      busInvalidate();
      getBus().catch(() => {});
      if (bu && bu.slug) rerender(bu.slug);
    } catch (e) { toastErr("Save failed: " + e.message); }
  });

  const clearBtn = modalBody.querySelector("#clear");
  if (clearBtn) clearBtn.addEventListener("click", async () => {
    if (!confirm("Clear the override and revert to the AI verdict?")) return;
    try {
      await api("DELETE", `/api/decision/${encodeURIComponent(item.key)}`, { actor: getActor() });
      closeModal();
      busInvalidate();
      getBus().catch(() => {});
      if (bu && bu.slug) rerender(bu.slug);
    } catch (e) { toastErr("Clear failed: " + e.message); }
  });
}

export async function openDecisionModalFromSearch(key, buSlug) {
  try {
    const bu = await api("GET", `/api/bu/${encodeURIComponent(buSlug)}`);
    openDecisionModal(key, null, bu);
  } catch (e) {
    toastErr("Could not open: " + e.message);
  }
}
