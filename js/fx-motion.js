// Small, home-built motion for the rooms: numbers that count up to their new value, and the ring
// used for the Training Room's week. The tick and the page transitions are pure CSS (css/base.css).
// Everything here gives way to reduced motion.

const REDUCED = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const NUM = /-?\d[\d,]*(\.\d+)?/;

/**
 * Set `el`'s text to `text`, counting the first number in it up (or down) from what was there
 * before: "$12.50", "75 min", "3/7". The first paint just sets the text.
 */
export function countTo(el, text) {
  if (!el) return;
  const was = el.dataset.count;
  el.dataset.count = text;
  const m = NUM.exec(text), p = was != null ? NUM.exec(was) : null;
  if (!m || !p || REDUCED() || was === text) { cancelAnimationFrame(el._fxRaf); el.textContent = text; return; }
  const to = parseFloat(m[0].replace(/,/g, "")), from = parseFloat(p[0].replace(/,/g, ""));
  if (from === to) { el.textContent = text; return; }
  const dp = (m[1] || "").length ? m[1].length - 1 : 0;
  const before = text.slice(0, m.index), after = text.slice(m.index + m[0].length);
  const t0 = performance.now(), dur = Math.min(900, 300 + Math.abs(to - from) * 40);
  cancelAnimationFrame(el._fxRaf);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    const v = from + (to - from) * e;
    el.textContent = k < 1 ? before + v.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp }) + after : text;
    if (k < 1) el._fxRaf = requestAnimationFrame(step);
  };
  el._fxRaf = requestAnimationFrame(step);
}

/** An SVG progress ring, `n` of `t`, that fills in from empty when it first appears. */
export function ring(n, t, { size = 56, stroke = 6 } = {}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, k = t ? Math.min(1, n / t) : 0;
  return `<svg class="fx-ring${k >= 1 ? " full" : ""}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${stroke}"/>
    <circle class="arc" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--green)" stroke-width="${stroke}" stroke-linecap="round"
      transform="rotate(-90 ${size / 2} ${size / 2})" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - k)).toFixed(2)}"
      style="--c:${c.toFixed(2)};${k ? "" : "opacity:0"}"/>
  </svg>`;
}
