// Small UI helpers: escaping, pills, toasts, dialogs, dates, and click handling.

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const pill = (label, cls) => `<span class="pill ${cls}">${esc(label)}</span>`;

// ---------- Dates (plant time is UTC+3, Africa/Kampala) ----------
const OFFSET = 3 * 3600_000;
export const plantNow = () => new Date(Date.now() + OFFSET);
export const today = () => plantNow().toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
export const monthOf = (d) => d.slice(0, 7) + "-01";
export const addMonths = (m, n) => { const d = new Date(Date.parse(m + "T00:00:00Z")); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const asDate = (d) => new Date(Date.parse(d + "T00:00:00Z"));
export const fmtDay = (d) => asDate(d).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
export const fmtDayW = (d) => asDate(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
export const fmtMonth = (m) => asDate(m).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
export const weekdayShort = (d) => asDate(d).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
export const fmtTime = (iso) => new Date(Date.parse(iso) + OFFSET).toISOString().slice(11, 16);
export const hrs = (min) => { const h = Math.round((min / 60) * 100) / 100; return (Number.isInteger(h) ? h : h.toFixed(1).replace(/\.0$/, "")) + "h"; };
export const mondayOf = (d) => { const w = asDate(d).getUTCDay(); return addDays(d, -((w + 6) % 7)); };

// ---------- Toast ----------
let toastTimer;
export function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3600);
}

// ---------- Click handling ----------
// Elements carry data-act="name"; views register handlers with on(name, fn). Cleared on each screen render.
let handlers = {};
export const on = (name, fn) => { handlers[name] = fn; };
export const resetHandlers = () => { handlers = {}; };
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const fn = handlers[el.dataset.act] ?? dialogHandlers[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  try { await fn(el, e); } catch (err) { toast(err.message ?? String(err)); }
});

// ---------- Dialog ----------
let dialogHandlers = {};
let dialogClose = null;
/** Opens a dialog. `handlers` work like on(); the returned close() removes it. */
export function dialog(html, dHandlers = {}, onClose) {
  closeDialog();
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">${html}</div>`;
  scrim.addEventListener("click", (e) => { if (e.target === scrim) closeDialog(); });
  document.body.append(scrim);
  dialogHandlers = { ...dHandlers, close: () => closeDialog() };
  dialogClose = () => { scrim.remove(); dialogHandlers = {}; dialogClose = null; onClose?.(); };
  scrim.querySelector("input,select,textarea,button")?.focus();
  return { el: scrim.querySelector(".dialog"), close: closeDialog };
}
export function closeDialog() { dialogClose?.(); }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDialog(); });

/** Reads a form's named fields into an object. */
export const formData = (root) => Object.fromEntries([...root.querySelectorAll("[name]")].map((el) => [el.name, el.type === "checkbox" ? el.checked : el.value.trim()]));

/** Shows an error inside a form instead of a toast. */
export function formError(root, msg) {
  const box = root.querySelector(".err");
  if (box) { box.textContent = msg; box.hidden = !msg; } else if (msg) toast(msg);
}

export const STATUS_PILL = { approved: ["Approved", "p-ok"], pending: ["Pending", "p-warn"], declined: ["Declined", "p-bad"], cancelled: ["Cancelled", "p-mute"] };
export const ROSTER_PILL = { none: ["Not started", "p-mute"], draft: ["Draft", "p-warn"], submitted: ["Waiting for approval", "p-info"], returned: ["Returned for changes", "p-bad"], approved: ["Approved and published", "p-ok"] };

/** Copies text, falling back to selecting it in a box. */
export async function copyText(text, fallbackBox) {
  try { await navigator.clipboard.writeText(text); toast("Copied. Paste it into Excel or Google Sheets."); }
  catch { if (fallbackBox) { fallbackBox.value = text; fallbackBox.hidden = false; fallbackBox.select(); toast("Copy the selected text."); } }
}
