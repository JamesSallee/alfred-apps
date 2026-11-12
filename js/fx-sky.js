// A woodblock-style graded sky that follows the real clock: dawn, day, dusk and night, with the sun
// or moon on its arc, stars after dark and the house-green hills beneath. Adapted from Forever
// Components' "Bokashi Sky" (Ukiyo-e Weather & Road).
//
// Built for the always-on console: it repaints once a minute (and when the theme changes), not
// every frame. The only moving part is a bird that crosses now and then, drawn as a CSS animation
// so the browser's compositor does the work. Reduced motion: no bird.
//
//   import { mountSky } from "./js/fx-sky.js";
//   mountSky(document.getElementById("sky"));

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Colours are CSS custom properties (see console.html), read on each repaint so the light and dark
// themes can each have their own sky. Fallbacks are the dark values.
const FALLBACK = {
  "dawn-top": "#2a3f63", "dawn-bot": "#d98a5a", "dawn-sun": "#f2c27a",
  "day-top": "#3f6f9f", "day-bot": "#cfe6ee", "day-sun": "#fdf6e3",
  "dusk-top": "#3a3360", "dusk-bot": "#c4663f", "dusk-sun": "#e8934a",
  "night-top": "#101a2e", "night-bot": "#22324b", "night-sun": "#e8edf2",
  hill: "#1f4d3a", star: "rgba(242,240,232,.9)",
};
const NAMES = ["dawn", "day", "dusk", "night"];
// The hour each phase is at its fullest. Between them the sky blends. (Long Island, roughly.)
const PEAK = [6.75, 12, 17, 23];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Where the clock sits between phases: [from, to, k]. */
function phaseAt(h) {
  for (let i = 0; i < 4; i++) {
    const a = PEAK[i], b = i === 3 ? PEAK[0] + 24 : PEAK[i + 1];
    const hh = h < PEAK[0] ? h + 24 : h;
    if (hh >= a && hh < b) return [i, (i + 1) % 4, (hh - a) / (b - a)];
  }
  return [3, 0, 0];
}

export function mountSky(host, { now = () => new Date() } = {}) {
  if (!host) return null;
  host.setAttribute("role", "img");
  host.innerHTML = `<canvas></canvas>${REDUCED ? "" : '<svg class="fx-bird" viewBox="0 0 16 8" aria-hidden="true"><path d="M1 5 Q8 -1 8 4 Q8 -1 15 5"/></svg>'}`;
  const cv = host.querySelector("canvas");
  const bird = host.querySelector(".fx-bird");
  const style = document.createElement("style");
  style.textContent = `
    .fx-sky{position:relative;overflow:hidden}
    .fx-sky canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
    .fx-bird{position:absolute;left:-20px;top:22%;width:16px;height:8px;fill:none;stroke:var(--sky-ink,#16202b);stroke-width:1.6;stroke-linecap:round;opacity:0;
      animation:fx-bird-cross 46s linear infinite}
    @keyframes fx-bird-cross{0%{transform:translate(0,0);opacity:0}4%{opacity:.6}50%{transform:translate(calc(var(--w,300px)*.5),-8px)}
      92%{opacity:.6}100%{transform:translate(calc(var(--w,300px) + 40px),4px);opacity:0}}
    .fx-sky.night .fx-bird{display:none}`;
  document.head.appendChild(style);
  host.classList.add("fx-sky");

  function draw() {
    const r = host.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height;
    host.style.setProperty("--w", W + "px");

    const cs = getComputedStyle(host);
    const tok = (n) => cs.getPropertyValue("--sky-" + n).trim() || FALLBACK[n];
    const d = now(), h = d.getHours() + d.getMinutes() / 60;
    const [i0, i1, k] = phaseAt(h);
    const col = (part) => mix(hex(tok(NAMES[i0] + "-" + part)), hex(tok(NAMES[i1] + "-" + part)), k);
    const top = col("top"), bot = col("bot"), sun = col("sun");
    const nightAmt = (i0 === 3 ? 1 - k : 0) + (i1 === 3 ? k : 0);
    host.classList.toggle("night", nightAmt > 0.5);
    host.setAttribute("aria-label", `The sky at ${NAMES[nightAmt > 0.5 ? 3 : k < 0.5 ? i0 : i1]}`);

    // The graded sky: bokashi is the woodblock printer's wiped gradient.
    const g = ctx.createLinearGradient(0, 0, 0, H * 0.85);
    g.addColorStop(0, rgb(top)); g.addColorStop(0.55, rgb(mix(top, bot, 0.55))); g.addColorStop(1, rgb(bot));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // Stars, at fixed places, fading in after dusk.
    if (nightAmt > 0.02) {
      ctx.fillStyle = tok("star");
      for (let s = 0; s < 22; s++) {
        ctx.globalAlpha = nightAmt * (0.35 + ((s * 37) % 10) / 16);
        ctx.fillRect((s * 97.3) % W, (s * 53.7) % (H * 0.55), 1.4, 1.4);
      }
      ctx.globalAlpha = 1;
    }

    // Sun from 6:45 to 16:45, the moon from 17:00 to 6:30, each on a low arc.
    const day = h >= 6.75 && h < 16.75;
    const span = day ? (h - 6.75) / 10 : ((h < 6.75 ? h + 24 : h) - 16.75) / 14;
    const sx = W * (0.06 + span * 0.88), sy = H * 0.72 - Math.sin(span * Math.PI) * H * 0.5;
    const rad = Math.max(8, Math.min(18, H * 0.09)) * (day ? 1 : 0.8);
    const halo = ctx.createRadialGradient(sx, sy, 2, sx, sy, rad * 2.6);
    halo.addColorStop(0, rgb(sun, 0.9)); halo.addColorStop(1, rgb(sun, 0));
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(sx, sy, rad * 2.6, 0, 7); ctx.fill();
    ctx.fillStyle = rgb(sun); ctx.beginPath(); ctx.arc(sx, sy, rad, 0, 7); ctx.fill();

    // Two bands of hills in the house green, the near one darker.
    const hill = hex(tok("hill"));
    ctx.fillStyle = rgb(mix(bot, hill, 0.45));
    ctx.beginPath(); ctx.moveTo(0, H * 0.78);
    ctx.quadraticCurveTo(W * 0.3, H * 0.62, W * 0.55, H * 0.74); ctx.quadraticCurveTo(W * 0.8, H * 0.84, W, H * 0.7);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
    ctx.fillStyle = rgb(mix(bot, hill, 0.8));
    ctx.beginPath(); ctx.moveTo(0, H * 0.9);
    ctx.quadraticCurveTo(W * 0.35, H * 0.8, W * 0.62, H * 0.88); ctx.quadraticCurveTo(W * 0.85, H * 0.95, W, H * 0.86);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
  }

  draw();
  const minute = setInterval(draw, 60000);
  new ResizeObserver(() => draw()).observe(host);
  new MutationObserver(() => draw()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const vis = () => { if (bird) bird.style.animationPlayState = document.hidden ? "paused" : "running"; if (!document.hidden) draw(); };
  document.addEventListener("visibilitychange", vis);
  return { draw, stop: () => clearInterval(minute) };
}
