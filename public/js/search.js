// Cmd/Ctrl+K global Epic search.
//
// Pulls the BU dataset once on first open, builds a flat index of every
// scored item across all BUs, and renders a quick-results palette. Enter
// (or click) navigates to the BU and opens the decision modal for the
// chosen item.
//
// Updates whenever the cached BU list changes (window dispatches
// "bus:updated" — fired by app.js after refresh / decision).

(function (global) {
  const PALETTE_ID = "k-palette";
  let items = null;       // flat [{key, summary, project_key, bu_slug, bu_name, ...}]
  let cursor = 0;
  let visible = [];

  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }

  async function loadIndex(force) {
    if (items && !force) return items;
    const all = [];
    const data = await fetch("/api/bus").then(r => r.json());
    // /api/bus is shallow (no items). Walk each BU.
    for (const bu of data.bus) {
      if ((bu.item_count || 0) === 0) continue;
      try {
        const detail = await fetch(`/api/bu/${encodeURIComponent(bu.slug)}`).then(r => r.json());
        for (const p of (detail.projects || [])) {
          for (const it of (p.items || [])) {
            all.push({
              key: it.key,
              summary: it.summary || "",
              parent_key: it.parent_key || "",
              parent_summary: it.parent_summary || "",
              project_key: it.project_key,
              bu_slug: detail.slug,
              bu_name: detail.name,
              current_verdict: it.current_verdict,
              has_decision: !!it.override
            });
          }
        }
      } catch { /* skip */ }
    }
    items = all;
    return items;
  }

  function score(it, q) {
    const ql = q.toLowerCase();
    const key = it.key.toLowerCase();
    if (key === ql) return 1000;
    if (key.startsWith(ql)) return 500;
    if (key.includes(ql)) return 300;
    const sum = (it.summary || "").toLowerCase();
    if (sum.startsWith(ql)) return 200;
    if (sum.includes(ql)) return 100;
    if ((it.parent_key || "").toLowerCase().includes(ql)) return 60;
    if ((it.parent_summary || "").toLowerCase().includes(ql)) return 40;
    if ((it.bu_name || "").toLowerCase().includes(ql)) return 20;
    return 0;
  }

  function render(query) {
    const box = document.getElementById(PALETTE_ID);
    if (!box) return;
    const list = box.querySelector(".k-results");
    const q = (query || "").trim();
    if (!q) {
      visible = [];
      list.innerHTML = `<div class="k-empty">Type to search Epics by key, summary, or parent Initiative. Across all BUs.</div>`;
      return;
    }
    if (items === null) {
      list.innerHTML = `<div class="k-empty"><span class="spinner-sm" style="margin-right:8px"></span>Indexing Epics…</div>`;
      return;
    }
    visible = items
      .map(it => ({ it, s: score(it, q) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map(x => x.it);
    cursor = 0;
    if (visible.length === 0) {
      list.innerHTML = `<div class="k-empty">No matches for "${esc(q)}".</div>`;
      return;
    }
    list.innerHTML = visible.map((it, i) => `
      <div class="k-row ${i === 0 ? "is-cursor" : ""}" data-idx="${i}">
        <div class="k-key">${esc(it.key)}</div>
        <div class="k-body">
          <div class="k-summary">${esc(it.summary)}</div>
          <div class="k-meta">${esc(it.bu_name)} · ${esc(it.project_key)}${it.parent_key ? " · " + esc(it.parent_key) : ""}</div>
        </div>
        <div class="k-verdict"><span class="pill ${esc(it.current_verdict)}">${esc(it.current_verdict)}</span>${it.has_decision ? `<span class="k-decided" title="Has a human decision">★</span>` : ""}</div>
      </div>
    `).join("");
    list.querySelectorAll(".k-row").forEach(r => {
      r.addEventListener("mouseenter", () => setCursor(parseInt(r.dataset.idx, 10)));
      r.addEventListener("click", () => choose(parseInt(r.dataset.idx, 10)));
    });
  }

  function setCursor(i) {
    cursor = Math.max(0, Math.min(visible.length - 1, i));
    const box = document.getElementById(PALETTE_ID);
    if (!box) return;
    box.querySelectorAll(".k-row").forEach((r, idx) => r.classList.toggle("is-cursor", idx === cursor));
    const row = box.querySelectorAll(".k-row")[cursor];
    if (row) row.scrollIntoView({ block: "nearest" });
  }

  function choose(i) {
    const it = visible[i];
    if (!it) return;
    close();
    // Navigate to the BU and open the decision modal.
    if (location.hash === `#/bu/${it.bu_slug}`) {
      // Same BU: trigger a re-route by replacing then re-setting hash so
      // bindBuEvents runs and the modal opens.
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      setTimeout(() => global.openDecisionModalFromSearch && global.openDecisionModalFromSearch(it.key, it.bu_slug), 50);
    } else {
      location.hash = `#/bu/${it.bu_slug}`;
      // Hash listener will renderBu. Open the modal after a short delay.
      setTimeout(() => global.openDecisionModalFromSearch && global.openDecisionModalFromSearch(it.key, it.bu_slug), 250);
    }
  }

  function open() {
    let box = document.getElementById(PALETTE_ID);
    if (!box) {
      box = document.createElement("div");
      box.id = PALETTE_ID;
      box.className = "k-palette";
      box.innerHTML = `
        <div class="k-card">
          <div class="k-header">
            <input class="k-input" placeholder="Find an Epic by key, summary, or Initiative…" autocomplete="off" spellcheck="false">
            <kbd>esc</kbd>
          </div>
          <div class="k-results"></div>
          <div class="k-footer">
            <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>esc</kbd> close</span>
          </div>
        </div>
      `;
      document.body.appendChild(box);
      const inp = box.querySelector(".k-input");
      inp.addEventListener("input", () => render(inp.value));
      inp.addEventListener("keydown", e => {
        if (e.key === "ArrowDown") { e.preventDefault(); setCursor(cursor + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(cursor - 1); }
        else if (e.key === "Enter") { e.preventDefault(); choose(cursor); }
        else if (e.key === "Escape") { e.preventDefault(); close(); }
      });
      box.addEventListener("click", e => { if (e.target === box) close(); });
    }
    box.classList.add("is-open");
    const inp = box.querySelector(".k-input");
    inp.value = "";
    inp.focus();
    render("");
    // Lazy-build index on first open.
    if (items === null) {
      loadIndex().then(() => render(inp.value)).catch(() => {
        const list = box.querySelector(".k-results");
        list.innerHTML = `<div class="k-empty">Could not load the Epic index.</div>`;
      });
    }
  }

  function close() {
    const box = document.getElementById(PALETTE_ID);
    if (box) box.classList.remove("is-open");
  }

  function isOpen() {
    const box = document.getElementById(PALETTE_ID);
    return !!(box && box.classList.contains("is-open"));
  }

  document.addEventListener("keydown", e => {
    // Cmd+K / Ctrl+K to open. Skip if user is mid-edit in a textarea so
    // they can still type the letters.
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (isOpen()) close(); else open();
    }
  });

  // Public hook for app.js to bust the index after a decision/refresh.
  global.kSearch = { open, close, invalidate: () => { items = null; } };
  window.addEventListener("bus:updated", () => { items = null; });
})(window);
