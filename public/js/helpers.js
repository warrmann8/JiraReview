// Shared constants, DOM refs, and small utilities used by every module.

export const VERDICTS = ["KEEP", "STOP", "FOLD", "FLAG"];
export const ACTOR_KEY = "scrub_actor";

export const app = document.getElementById("app");
export const modal = document.getElementById("modal");
export const modalBody = document.getElementById("modal-body");
export const sidebar = document.getElementById("sidebar");
export const sideBus = document.getElementById("side-bus");
export const sideStatus = document.getElementById("side-status");
export const sideActor = document.getElementById("side-actor");

export const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
export const fmtDate = (iso) => iso ? new Date(iso).toLocaleString() : "—";

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}

// Actor identity in dev mode (no SSO). When SSO is enabled the server
// records the session user's email and ignores this value.
export function getActor() {
  const inp = document.getElementById("actor");
  const fromInput = inp ? inp.value.trim() : "";
  return fromInput || localStorage.getItem(ACTOR_KEY) || "anonymous";
}
export function saveActor() {
  const inp = document.getElementById("actor");
  if (inp && inp.value.trim()) localStorage.setItem(ACTOR_KEY, inp.value.trim());
}

export function verdictBar(t) {
  if (!t || !t.total) return `<div class="verdict-bar"></div>`;
  const segs = VERDICTS.map(v => `<span class="seg-${v}" style="width:${(100 * (t[v] || 0)) / t.total}%"></span>`).join("");
  return `<div class="verdict-bar">${segs}</div>`;
}

export function initialsOf(name) {
  if (!name) return "?";
  const parts = name.replace(/[._-]/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return name.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Cached BU list — the sidebar, search palette, and several other views
// share this. busInvalidate() also dispatches a window event so the Cmd+K
// search index reloads after a decision.
let _busCache = null;
export function busCache() { return _busCache; }
export function setBusCache(v) { _busCache = v; }
export function busInvalidate() {
  _busCache = null;
  window.dispatchEvent(new Event("bus:updated"));
}
export async function getBus(populate) {
  if (_busCache) return _busCache;
  const data = await api("GET", "/api/bus");
  _busCache = data;
  if (typeof populate === "function") populate(data);
  return data;
}
