// One small line icon per room, drawn on a 24x24 grid in currentColor.
// Used by the Study's room list and by each room's own header (via shell.js).
// The Study's markup carries static copies so it paints without waiting for JS; keep them in step.

export const ICONS = {
  ledger:   '<rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M8.5 3.5v17"/><path d="M11 12l2 2 3.5-4"/>',
  focus:    '<path d="M7 3.5h10M7 20.5h10M8 3.5v2.2a4 4 0 0 0 1.6 3.2L12 12l2.4-3.1A4 4 0 0 0 16 5.7V3.5M8 20.5v-2.2a4 4 0 0 1 1.6-3.2L12 12l2.4 3.1a4 4 0 0 1 1.6 3.2v2.2"/>',
  shutdown: '<path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10z"/><path d="M17.5 3.5v3M16 5h3"/>',
  larder:   '<path d="M2.5 15.5c0-4 4.3-7 9.5-7s9.5 3 9.5 7c0 1.7-1.3 3-3 3h-13c-1.7 0-3-1.3-3-3z"/><path d="M7.5 10l2 3M11.5 9l2 3M15.5 10l2 3"/>',
  desk:     '<path d="M12 21.5l-5-9 2-6h6l2 6z"/><path d="M12 21.5V14"/><circle cx="12" cy="12.5" r="1.5"/><path d="M9 3.5h6"/>',
  training: '<rect x="5" y="7" width="3" height="10" rx="1"/><rect x="16" y="7" width="3" height="10" rx="1"/><path d="M3 10v4M21 10v4M8 12h8"/>',
  todo:     '<path d="M9 6.5h11M9 12h11M9 17.5h7"/><path d="M3.5 6.5l1.3 1.3L7 5.5"/><path d="M3.5 12l1.3 1.3L7 11"/><circle cx="5" cy="17.5" r="1.2"/>',
  podcast:  '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5v3M9 20.5h6"/>',
  reading:  '<path d="M12 6.5c-1.8-1.4-4.6-2-8-1.8v13c3.4-.2 6.2.4 8 1.8 1.8-1.4 4.6-2 8-1.8v-13c-3.4-.2-6.2.4-8 1.8z"/><path d="M12 6.5v13"/><path d="M15.5 4.6v5l1.25-1 1.25 1v-5.3"/>',
  wardrobe: '<path d="M12 9.5V8.3c0-.6.4-1 .9-1.3A2 2 0 1 0 10 5.3"/><path d="M12 9.5l-8.4 6.2c-.8.6-.4 1.8.6 1.8h15.6c1 0 1.4-1.2.6-1.8z"/>',
};

/** An inline <svg> string for a room, or "" if there is none. */
export function iconSvg(app) {
  const body = ICONS[app];
  return body ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>` : "";
}
