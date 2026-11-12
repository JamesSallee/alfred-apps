// Small helpers every page used to write out for itself.

/** Escape text for use inside HTML. null and undefined become "". */
export const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** document.getElementById, for pages that write $("id"). */
export const byId = (id) => document.getElementById(id);

/** document.querySelector, for pages that write $("#id") or $(".class"). */
export const qs = (s) => document.querySelector(s);
