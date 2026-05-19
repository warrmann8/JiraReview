// Entry point. Wires routing + sidebar + first render.
// Per-feature code lives in /js/ — sidebar.js, landing.js, bu.js,
// modal.js, ingest.js, prompt-editor.js, toast.js, search.js, helpers.js.

import { getBus } from "./js/helpers.js";
import {
  bindSidebar, populateSideBus, refreshHeaderStatus, setNavActive
} from "./js/sidebar.js";
import { renderLanding } from "./js/landing.js";
import { renderBu } from "./js/bu.js";
import { renderPromptEditor } from "./js/prompt-editor.js";
import { setModalRerender } from "./js/modal.js";
import { open as openSearch } from "./js/search.js";

function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  setNavActive();
  if (hash.startsWith("/bu/")) renderBu(hash.slice(4));
  else if (hash === "/prompt" || hash.startsWith("/prompt")) renderPromptEditor();
  else renderLanding();
}

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", () => {
  bindSidebar({ onRefreshDone: () => route() });
  const sideSearch = document.getElementById("side-search");
  if (sideSearch) sideSearch.addEventListener("click", openSearch);

  // Decisions made in the modal trigger a BU re-render; the modal can't
  // import bu.js because that would create a cycle (bu.js imports modal.js).
  setModalRerender((slug) => renderBu(slug));

  refreshHeaderStatus();
  getBus(populateSideBus).catch(() => {});
  route();
});
