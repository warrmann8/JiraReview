// Toast notifications — non-blocking replacement for alert().

const STACK_ID = "toasts";

function esc(s) {
  return (s == null ? "" : String(s)).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function ensureStack() {
  let stack = document.getElementById(STACK_ID);
  if (!stack) {
    stack = document.createElement("div");
    stack.id = STACK_ID;
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

export function toast(message, opts) {
  opts = opts || {};
  const stack = ensureStack();
  const el = document.createElement("div");
  const type = opts.type || "ok";
  el.className = "toast " + type;
  const body = opts.title
    ? `<div class="toast-body"><div class="toast-title">${esc(opts.title)}</div>${esc(message)}</div>`
    : `<div class="toast-body">${esc(message)}</div>`;
  el.innerHTML = body + `<button class="toast-close" aria-label="Dismiss">×</button>`;
  stack.appendChild(el);

  const duration = opts.duration === 0 ? 0 : (opts.duration || (type === "err" ? 6000 : 3500));
  let timer = null;
  const dismiss = () => {
    if (!el.parentNode) return;
    el.classList.add("fade-out");
    setTimeout(() => el.remove(), 200);
    if (timer) clearTimeout(timer);
  };
  el.querySelector(".toast-close").addEventListener("click", dismiss);
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return dismiss;
}

export const toastOk   = (msg, opts) => toast(msg, { ...opts, type: "ok" });
export const toastWarn = (msg, opts) => toast(msg, { ...opts, type: "warn" });
export const toastErr  = (msg, opts) => toast(msg, { ...opts, type: "err" });
