// Sidebar: BU rail, status indicators, actor / SSO widget, refresh-all.

import {
  VERDICTS, ACTOR_KEY, sidebar, sideBus, sideStatus, sideActor,
  esc, api, initialsOf, busInvalidate, getBus
} from "./helpers.js";

const SIDEBAR_KEY = "scrub_sidebar_expanded";

export function applySidebarState() {
  const expanded = localStorage.getItem(SIDEBAR_KEY) === "1";
  sidebar.classList.toggle("expanded", expanded);
}

export function bindSidebar({ onRefreshDone } = {}) {
  const sideToggle = document.getElementById("side-toggle");
  if (sideToggle) {
    sideToggle.addEventListener("click", () => {
      const isExpanded = sidebar.classList.toggle("expanded");
      localStorage.setItem(SIDEBAR_KEY, isExpanded ? "1" : "0");
    });
  }
  applySidebarState();

  refreshAllImpl._onDone = onRefreshDone;
}

function buInitials(name) {
  // "AFI Data & Analytics" -> "DA"; "AGR Customer Care" -> "CC"
  const skip = new Set(["afi", "agr", "the", "of", "and", "&"]);
  const words = name.replace(/[/(),]/g, " ").split(/\s+/).filter(w => w && !skip.has(w.toLowerCase()));
  if (words.length === 0) return name.slice(0, 2).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function populateSideBus(data) {
  if (!sideBus) return;
  const current = location.hash.startsWith("#/bu/") ? location.hash.slice(5) : "";
  const sorted = data.bus.slice().sort((a, b) => {
    const ap = (a.item_count || 0) > 0 ? 1 : 0;
    const bp = (b.item_count || 0) > 0 ? 1 : 0;
    if (ap !== bp) return bp - ap;
    if (ap) return (b.item_count || 0) - (a.item_count || 0);
    return a.name.localeCompare(b.name);
  });
  sideBus.innerHTML = sorted.map(bu => {
    const t = bu.tally || { KEEP: 0, STOP: 0, FOLD: 0, FLAG: 0, total: 0, overrides: 0 };
    const empty = (bu.item_count || 0) === 0;
    const initials = buInitials(bu.name);
    const segs = t.total ? VERDICTS.map(v => `<span class="seg-${v}" style="width:${(100 * (t[v] || 0)) / t.total}%"></span>`).join("") : "";
    const meta = empty
      ? `<div class="bu-meta">empty</div>`
      : `<div class="bu-meta">${bu.item_count} epic${bu.item_count === 1 ? "" : "s"}${t.overrides ? ` · <span class="ov">${t.overrides} override${t.overrides === 1 ? "" : "s"}</span>` : ""}</div>
         ${segs ? `<div class="bu-bar">${segs}</div>` : ""}`;
    return `<a class="side-bu${empty ? " empty" : ""}${bu.slug === current ? " active" : ""}" href="#/bu/${esc(bu.slug)}" title="${esc(bu.name)}">
      <span class="bu-mark">${esc(initials)}</span>
      <div class="bu-body">
        <div class="bu-name">${esc(bu.name)}</div>
        ${meta}
      </div>
    </a>`;
  }).join("");
}

export function setNavActive() {
  const h = location.hash || "";
  let activeRoute = "";
  if (!h || h === "#" || h === "#/") activeRoute = "home";
  else if (h.startsWith("#/prompt")) activeRoute = "prompt";
  document.querySelectorAll(".side-item[data-route]").forEach(a => {
    a.classList.toggle("active", a.dataset.route === activeRoute);
  });
  const cur = location.hash.startsWith("#/bu/") ? location.hash.slice(5) : "";
  document.querySelectorAll(".side-bu").forEach(b => {
    b.classList.toggle("active", b.getAttribute("href") === `#/bu/${cur}`);
  });
}

export async function refreshHeaderStatus() {
  // Scorer + Jira indicators
  const scorerBits = await (async () => {
    try {
      const s = await api("GET", "/api/scorer/info");
      return { cls: s.configured ? "ok" : "warn", txt: `scorer · ${s.configured ? s.provider : "off"}` };
    } catch { return { cls: "err", txt: "scorer · error" }; }
  })();
  const jiraBits = await (async () => {
    try {
      const j = await api("GET", "/api/jira/status");
      if (!j.configured) return { cls: "warn", txt: "jira · offline" };
      if (j.ping_ok === false || j.error) return { cls: "warn", txt: "jira · stubs" };
      return { cls: "ok", txt: "jira · live" };
    } catch { return { cls: "err", txt: "jira · error" }; }
  })();
  sideStatus.innerHTML = `
    <div class="status ${scorerBits.cls}" title="${esc(scorerBits.txt)}"><span class="dot"></span><span class="txt">${esc(scorerBits.txt)}</span></div>
    <div class="status ${jiraBits.cls}" title="${esc(jiraBits.txt)}"><span class="dot"></span><span class="txt">${esc(jiraBits.txt)}</span></div>
  `;

  // Actor widget — SSO-aware
  let me = { enabled: false, user: null };
  try { me = await api("GET", "/auth/me"); } catch {}
  if (!me.enabled) {
    const saved = localStorage.getItem(ACTOR_KEY) || "";
    sideActor.innerHTML = `
      <div class="actor-row" title="${esc(saved || "anonymous")}"><div class="avatar">${esc(initialsOf(saved || "?"))}</div><span class="who">${esc(saved || "anonymous")}</span></div>
      <input id="actor" placeholder="your name" value="${esc(saved)}">
      <div class="row-actions">
        <button class="mini-btn" id="refreshAll" title="Re-read live data">Refresh all</button>
      </div>
    `;
    const inp = document.getElementById("actor");
    inp.addEventListener("change", () => {
      if (inp.value.trim()) localStorage.setItem(ACTOR_KEY, inp.value.trim());
      sideActor.querySelector(".avatar").textContent = initialsOf(inp.value.trim() || "?");
      sideActor.querySelector(".who").textContent = inp.value.trim() || "anonymous";
    });
  } else if (me.user) {
    const display = me.user.name || me.user.email || me.user.oid;
    sideActor.innerHTML = `
      <div class="actor-row" title="${esc(display)}"><div class="avatar">${esc(initialsOf(display))}</div><span class="who">${esc(display)}</span></div>
      <div class="row-actions">
        <button class="mini-btn" id="refreshAll">Refresh</button>
        <button class="mini-btn" id="sso-logout">Sign out</button>
      </div>
    `;
    document.getElementById("sso-logout").addEventListener("click", async () => {
      try { await api("POST", "/auth/logout"); } catch {}
      location.reload();
    });
  } else {
    sideActor.innerHTML = `
      <div class="actor-row"><div class="avatar">?</div><span class="who">signed out</span></div>
      <div class="row-actions">
        <a href="/auth/login" class="mini-btn primary" style="flex:1;text-decoration:none">Sign in</a>
      </div>
    `;
  }
  const r = document.getElementById("refreshAll");
  if (r) r.addEventListener("click", refreshAllImpl);
}

async function refreshAllImpl(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.dataset.orig = btn.textContent;
  btn.innerHTML = `<span class="spinner-sm"></span>`;
  try {
    await api("POST", "/api/refresh");
    busInvalidate();
    await refreshHeaderStatus();
    await getBus(populateSideBus);
    if (refreshAllImpl._onDone) refreshAllImpl._onDone();
  } finally {
    btn.disabled = false;
    btn.textContent = btn.dataset.orig || "Refresh";
  }
}
refreshAllImpl._onDone = null;
