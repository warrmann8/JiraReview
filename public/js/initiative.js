// Initiative-level view: every Epic across every BU under a parent
// Initiative. Two routes — index of initiatives + one initiative's items.

import { VERDICTS, app, esc, api, verdictBar } from "./helpers.js";
import { openDecisionModalFromSearch } from "./modal.js";

export async function renderInitiativesIndex() {
  app.innerHTML = `<div class="crumb"><a href="#/">Portfolio</a><span class="crumb-sep">›</span><span id="cur">Initiatives</span></div>
    <div id="init-body">Loading…</div>`;
  let data;
  try { data = await api("GET", "/api/initiatives"); }
  catch (e) {
    document.getElementById("init-body").innerHTML = `<div class="note">Could not load initiatives: ${esc(e.message)}</div>`;
    return;
  }

  const rows = data.initiatives.map(i => {
    const label = i.unlinked ? "(unlinked Epics)" : i.key;
    const buCount = Object.keys(i.bus).length;
    const buNames = Object.values(i.bus).map(b => b.name).join(", ");
    return `
      <a class="init-row${i.unlinked ? " is-unlinked" : ""}" href="#/initiative/${esc(i.key || "__unlinked__")}">
        <div class="init-key">${esc(label)}</div>
        <div class="init-body">
          <div class="init-summary">${esc(i.summary || (i.unlinked ? "Epics with no parent Initiative" : "—"))}</div>
          <div class="init-meta">${i.item_count} Epic${i.item_count === 1 ? "" : "s"} across ${buCount} BU${buCount === 1 ? "" : "s"} · ${esc(buNames)}${i.override_count ? ` · <span class="ov">${i.override_count} decided</span>` : ""}</div>
        </div>
        <div class="init-bar">${verdictBar(i.by_verdict ? { ...i.by_verdict, total: i.item_count } : { total: 0 })}</div>
        <div class="init-counts">
          ${VERDICTS.map(v => `<span class="c c-${v}"><b>${i.by_verdict[v] || 0}</b>${v[0]}</span>`).join("")}
        </div>
      </a>
    `;
  }).join("");

  document.getElementById("init-body").innerHTML = `
    <div class="eyebrow">strategic axis · ${data.initiatives.length} initiatives</div>
    <h1 style="margin:6px 0 14px">Browse by Initiative</h1>
    <div class="sub" style="color:var(--mid);margin:0 0 18px;font-size:14px">Roll-up across every BU. An Initiative groups the Epics that execute one strategic commitment (e.g. <code>AFIINIT-31 — Next-Gen Supply Chain Planning</code>). Click an Initiative to see every Epic under it, across every BU it touches.</div>
    <div class="init-list">${rows}</div>
  `;
}

export async function renderInitiativeDetail(key) {
  app.innerHTML = `<div class="crumb">
      <a href="#/">Portfolio</a>
      <span class="crumb-sep">›</span>
      <a href="#/initiatives">Initiatives</a>
      <span class="crumb-sep">›</span>
      <span id="cur">${esc(key === "__unlinked__" ? "(unlinked)" : key)}</span>
    </div>
    <div id="init-body">Loading…</div>`;

  let data;
  try { data = await api("GET", `/api/initiative/${encodeURIComponent(key)}`); }
  catch (e) {
    document.getElementById("init-body").innerHTML = `<div class="note">Could not load initiative: ${esc(e.message)}</div>`;
    return;
  }

  // Group items by BU for rendering.
  const byBu = new Map();
  for (const it of data.items) {
    if (!byBu.has(it.bu_slug)) byBu.set(it.bu_slug, { name: it.bu_name, items: [] });
    byBu.get(it.bu_slug).items.push(it);
  }
  const buBlocks = Array.from(byBu.entries()).sort((a, b) => b[1].items.length - a[1].items.length).map(([slug, g]) => `
    <section class="init-bu">
      <header class="proj">
        <div class="proj-left">
          <span class="pkey"><a href="#/bu/${esc(slug)}">${esc(g.name)}</a></span>
        </div>
        <div class="proj-right">
          <span class="pcount"><b>${g.items.length}</b> Epic${g.items.length === 1 ? "" : "s"}</span>
        </div>
      </header>
      <table class="items"><tbody>
        ${g.items.map(it => renderInitiativeRow(it)).join("")}
      </tbody></table>
    </section>
  `).join("");

  const t = data.tally;
  document.getElementById("init-body").innerHTML = `
    <div class="eyebrow">initiative ${data.unlinked ? "· unlinked Epics" : ""}</div>
    <h1 style="margin:6px 0 6px">${esc(data.key || "(unlinked)")}</h1>
    <div class="summary" style="margin-top:10px">${esc(data.summary || (data.unlinked ? "These Epics have no parent Initiative. Each is an outlier that should probably be linked to one, or — if it really is standalone work — converted into its own Initiative." : "—"))}</div>
    <div class="metric-strip">
      <div class="metric"><div class="num">${t.total}</div><div class="label">Epics</div></div>
      <div class="metric"><div class="num">${byBu.size}</div><div class="label">BUs touched</div></div>
      <div class="metric ${t.overrides ? "is-accent" : ""}"><div class="num">${t.overrides}</div><div class="label">Decisions made</div></div>
      <div class="metric"><div class="num" style="color:#b6c7a9">${t.KEEP}</div><div class="label">Keep</div></div>
      <div class="metric"><div class="num" style="color:#d28d8d">${t.STOP}</div><div class="label">Stop</div></div>
      <div class="metric"><div class="num" style="color:#e2c39e">${t.FOLD}</div><div class="label">Fold</div></div>
      <div class="metric"><div class="num" style="color:#a7c5d7">${t.FLAG}</div><div class="label">Flag</div></div>
    </div>
    ${buBlocks}
  `;

  // Click any row to open the decision modal — same UX as the BU page.
  document.querySelectorAll(".init-bu table.items tbody tr").forEach(tr => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      openDecisionModalFromSearch(tr.dataset.key, tr.dataset.bu);
    });
  });
}

function renderInitiativeRow(it) {
  const overridden = !!it.override;
  const decided = overridden ? it.override.verdict : null;
  const isDelta = overridden && decided !== it.ai_verdict;
  const verdictCell = isDelta
    ? `<span class="pill subtle ${esc(it.ai_verdict)}">${esc(it.ai_verdict)}</span> <span class="delta-arrow">→</span> <span class="pill ${esc(decided)} is-override">${esc(decided)}</span>`
    : `<span class="pill ${esc(it.current_verdict)} ${overridden ? "is-override" : ""}">${esc(it.current_verdict)}</span>`;
  return `<tr class="${overridden ? "has-decision" : ""}${isDelta ? " is-delta" : ""}" data-key="${esc(it.key)}" data-bu="${esc(it.bu_slug)}">
    <td style="width:120px"><a class="key" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.key)}</a></td>
    <td><div class="summary">${esc(it.summary)}</div><div class="parent-tag">${esc(it.project_name)}</div></td>
    <td style="width:90px">${esc(it.status || "")}</td>
    <td style="width:240px">${verdictCell}</td>
    <td>${esc(overridden ? it.override.reason || it.ai_reason : it.ai_reason || "")}</td>
  </tr>`;
}
