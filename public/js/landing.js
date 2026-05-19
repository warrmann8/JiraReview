// Landing / Portfolio page: hero band, BU grid, last-30-days activity.

import { VERDICTS, app, esc, api, verdictBar, setBusCache } from "./helpers.js";
import { populateSideBus } from "./sidebar.js";

export async function renderLanding() {
  let data;
  try {
    data = await api("GET", "/api/bus");
    setBusCache(data);
    populateSideBus(data);
  } catch (e) {
    app.innerHTML = `<div class="note">Could not load BUs: ${esc(e.message)}</div>`;
    return;
  }

  const totals = { KEEP: 0, STOP: 0, FOLD: 0, FLAG: 0, total: 0, overrides: 0 };
  let populated = 0;
  let signedOff = 0;
  for (const bu of data.bus) {
    const t = bu.tally || {};
    for (const v of VERDICTS) totals[v] += t[v] || 0;
    totals.total += t.total || 0;
    totals.overrides += t.overrides || 0;
    if ((bu.item_count || 0) > 0) populated++;
    if (bu.signoff) signedOff++;
  }

  app.innerHTML = `
    <div class="eyebrow">portfolio · 17 business units · 91 projects</div>
    <h2 style="margin-top:6px;margin-bottom:14px">Scrub console</h2>

    <div class="portfolio">
      <div class="cell"><div class="num">${totals.total}</div><div class="label">Epics scored</div></div>
      <div class="cell"><div class="num">${populated}<span style="color:var(--low);font-size:18px">/${data.bus.length}</span></div><div class="label">BUs populated</div></div>
      <div class="cell ${signedOff ? "accent" : ""}"><div class="num">${signedOff}<span style="color:var(--low);font-size:18px">/${data.bus.length}</span></div><div class="label">BUs signed off</div></div>
      <div class="cell accent"><div class="num">${totals.overrides}</div><div class="label">Decisions logged</div></div>
      <div class="cell split">
        <div class="item"><div class="num" style="color:#b6c7a9">${totals.KEEP}</div><div class="label">Keep</div></div>
        <div class="item"><div class="num" style="color:#d28d8d">${totals.STOP}</div><div class="label">Stop</div></div>
        <div class="item"><div class="num" style="color:#e2c39e">${totals.FOLD}</div><div class="label">Fold</div></div>
        <div class="item"><div class="num" style="color:#a7c5d7">${totals.FLAG}</div><div class="label">Flag</div></div>
      </div>
    </div>

    <div id="activity-panel"></div>
    <div id="flagged-panel"></div>

    <h2 style="margin-bottom:8px">Business units</h2>
    <div class="sub" style="color:var(--mid);margin:0 0 16px;font-size:14px">Click a populated BU to walk its Epics. Empty BUs are placeholders — use <b style="color:var(--hi)">Add items…</b> on any BU page to ingest scored Epics.</div>
    <div class="bu-grid" id="bu-grid"></div>
  `;

  loadActivity(data).catch(() => {});
  loadFlaggedUnattended().catch(() => {});

  const grid = document.getElementById("bu-grid");
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
    card.className = "bu-card" + (empty ? " empty" : "") + (bu.signoff ? " signed-off" : "");
    card.href = `#/bu/${bu.slug}`;
    const sob = bu.signoff
      ? `<div class="signoff-badge" title="Signed off by ${esc(bu.signoff.actor)} · ${esc(new Date(bu.signoff.decided_at).toLocaleString())}">★ signed off · ${esc(bu.signoff.actor)}</div>`
      : "";
    card.innerHTML = `
      <div class="name">${esc(bu.name)}</div>
      <div class="stats">${bu.project_count} projects · ${bu.item_count} items${t.overrides ? ` · <b style="color:var(--accent)">${t.overrides} overrides</b>` : ""}${empty ? ' · <span class="empty-tag">empty</span>' : ""}</div>
      ${verdictBar(t)}
      <div class="mini-counts">${counts}</div>
      ${sob}
    `;
    grid.appendChild(card);
  }
}

async function loadFlaggedUnattended() {
  const panel = document.getElementById("flagged-panel");
  if (!panel) return;
  let data;
  try { data = await api("GET", "/api/flagged-unattended"); }
  catch { return; }
  if (!data.total) { panel.innerHTML = ""; return; }
  const rows = data.items.slice(0, 8).map(it => `
    <a class="flag-row" href="#/bu/${esc(it.bu_slug)}" data-key="${esc(it.key)}">
      <span class="flag-key">${esc(it.key)}</span>
      <span class="flag-summary">${esc(it.summary || "")}</span>
      <span class="flag-meta">${esc(it.bu_name)} · ${esc(it.project_key)}${it.parent_key ? " · " + esc(it.parent_key) : ""}</span>
      <span class="flag-verdict">
        <span class="pill ${esc(it.ai_verdict)}">${esc(it.ai_verdict)}</span>
        ${it.confidence === "low" ? `<span class="conf-low" title="AI confidence: low">low conf.</span>` : ""}
      </span>
    </a>
  `).join("");
  panel.innerHTML = `
    <section class="flagged-panel">
      <div class="flagged-head">
        <div>
          <div class="eyebrow">attention · AI flagged, no human review</div>
          <h2 style="margin-top:4px">Needs your eyes</h2>
        </div>
        <div class="flagged-total"><b>${data.total}</b> ${data.total === 1 ? "Epic" : "Epics"}</div>
      </div>
      <div class="flag-list">${rows}</div>
      ${data.total > 8 ? `<div class="flag-more">…and ${data.total - 8} more. Use Cmd+K to search or open a BU to filter by <b>Needs attention</b>.</div>` : ""}
    </section>
  `;
}

async function loadActivity(busData) {
  const panel = document.getElementById("activity-panel");
  if (!panel) return;
  let data;
  try { data = await api("GET", "/api/activity?days=30"); }
  catch { return; }
  if (!data.total) { panel.innerHTML = ""; return; }
  const buNames = {};
  for (const bu of busData.bus) buNames[bu.slug] = bu.name;
  const topBus = Object.entries(data.by_bu).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const topActors = Object.entries(data.by_actor).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const recent = (data.recent || []).slice(0, 5);

  panel.innerHTML = `
    <section class="activity">
      <div class="activity-head">
        <div class="eyebrow">activity · last 30 days</div>
        <h2 style="margin-top:4px">Decisions logged</h2>
      </div>
      <div class="activity-grid">
        <div class="activity-cell">
          <div class="num">${data.total}</div>
          <div class="label">Decisions</div>
          <div class="sub-meta">${data.changed_from_ai} changed · ${data.confirmed_ai} confirmed AI</div>
        </div>
        <div class="activity-cell">
          <div class="label">By verdict</div>
          <div class="bigbar">
            ${VERDICTS.map(v => {
              const c = data.by_verdict[v] || 0;
              return c ? `<span class="seg seg-${v}" style="flex:${c}" title="${v}: ${c}"></span>` : "";
            }).filter(Boolean).join("")}
          </div>
          <div class="legend">
            ${VERDICTS.map(v => `<span class="leg leg-${v}"><b>${data.by_verdict[v] || 0}</b> ${v}</span>`).join("")}
          </div>
        </div>
        <div class="activity-cell">
          <div class="label">Top BUs</div>
          ${topBus.length ? `<ul class="ranklist">${topBus.map(([slug, n]) => `<li><a href="#/bu/${esc(slug)}">${esc(buNames[slug] || slug)}</a><b>${n}</b></li>`).join("")}</ul>` : `<div class="empty">no BUs yet</div>`}
        </div>
        <div class="activity-cell">
          <div class="label">Reviewers</div>
          ${topActors.length ? `<ul class="ranklist">${topActors.map(([a, n]) => `<li><span>${esc(a)}</span><b>${n}</b></li>`).join("")}</ul>` : `<div class="empty">—</div>`}
        </div>
      </div>
      ${recent.length ? `
        <div class="activity-recent">
          <div class="label">Recent</div>
          <ul class="recent-list">
            ${recent.map(d => {
              const delta = d.ai_verdict && d.new_verdict !== d.ai_verdict;
              return `<li>
                <a href="#/bu/${esc(d.bu_slug)}" data-key="${esc(d.key)}" class="recent-item">
                  <span class="when">${esc(new Date(d.decided_at).toLocaleString())}</span>
                  <span class="who">${esc(d.actor || "anonymous")}</span>
                  <span class="rkey">${esc(d.key)}</span>
                  <span class="rverdict">${delta
                    ? `<span class="pill subtle ${esc(d.ai_verdict)}">${esc(d.ai_verdict)}</span> → <span class="pill ${esc(d.new_verdict)}">${esc(d.new_verdict)}</span>`
                    : `<span class="pill ${esc(d.new_verdict)}">${esc(d.new_verdict)}</span>`}</span>
                  <span class="rwhere">${esc(buNames[d.bu_slug] || d.bu_slug)}</span>
                </a>
              </li>`;
            }).join("")}
          </ul>
        </div>` : ""}
    </section>
  `;
}
