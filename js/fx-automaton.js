// A slow cellular automaton for behind the breathing circle: a one-dimensional rule grows a pattern
// line by line, the oldest lines fading as they drift up, and every screenful a new rule takes over
// (90 draws Sierpinski triangles, 30 is chaos, 110 is famously able to compute anything).
// Adapted from Forever Components' "Cellular Automaton" (Generative Geometry), slowed right down for
// meditation, drawn in the house green, and faded out around the circle so the cue stays readable.
// Reduced motion: one still frame.
//
//   import { mountAutomaton } from "./js/fx-automaton.js";
//   const bg = mountAutomaton(panelEl);   // adds a canvas behind the panel's content
//   bg.start(); bg.stop(); bg.remove();

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const RULES = [90, 30, 110, 150, 54, 60, 182, 18, 22, 73];
const ROW_MS = 420;            // one new line every 0.42 s: slow enough to watch without reading it

const CSS = `
.fx-ca-host{position:relative;isolation:isolate}
.fx-ca{position:absolute;inset:0;width:100%;height:100%;z-index:-1;border-radius:inherit;pointer-events:none;
  -webkit-mask-image:radial-gradient(circle at 50% 120px,transparent 0 95px,#000 190px);mask-image:radial-gradient(circle at 50% 120px,transparent 0 95px,#000 190px);
  opacity:.55;transition:opacity .8s ease}
.fx-ca-rule{position:absolute;right:12px;top:10px;font-size:12px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);pointer-events:none}
`;

export function mountAutomaton(host) {
  if (!document.getElementById("fx-ca-css")) {
    const st = document.createElement("style"); st.id = "fx-ca-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  host.classList.add("fx-ca-host");
  const cv = document.createElement("canvas");
  cv.className = "fx-ca"; cv.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "fx-ca-rule";
  host.prepend(cv); host.append(label);
  const ctx = cv.getContext("2d");

  let W = 0, H = 0, cell = 4, COLS = 0, ROWS = 0, grid = [], ri = 0, rule = RULES[0], head = 0, ink = "#1f4d3a";
  const pick = (i) => { rule = RULES[((i % RULES.length) + RULES.length) % RULES.length]; label.textContent = "Rule " + rule; };
  const seed = () => {
    const r = new Uint8Array(COLS);
    if ([90, 150, 18, 22].includes(rule)) r[COLS >> 1] = 1;
    else for (let i = 0; i < COLS; i++) r[i] = Math.random() < 0.5 ? 1 : 0;
    return r;
  };
  const next = (p) => {
    const r = new Uint8Array(COLS);
    for (let i = 0; i < COLS; i++) r[i] = (rule >> ((p[(i - 1 + COLS) % COLS] << 2) | (p[i] << 1) | p[(i + 1) % COLS])) & 1;
    return r;
  };
  function size() {
    const r = host.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    if (r.width < 4) return;
    W = r.width; H = r.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cell = Math.max(3, Math.round(Math.min(W, H) / 90));
    COLS = Math.ceil(W / cell) + 1; ROWS = Math.ceil(H / cell) + 1;
    pick(ri); grid = [seed()]; head = 0;
    while (grid.length < ROWS) grid.push(next(grid[grid.length - 1]));
    draw();
  }
  function step() {
    grid.push(next(grid[grid.length - 1]));
    if (grid.length > ROWS) { grid.shift(); head++; }
    if (head > 0 && head % ROWS === 0) { ri++; pick(ri); grid[grid.length - 1] = seed(); }
  }
  function draw() {
    ink = getComputedStyle(host).getPropertyValue("--green").trim() || ink;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = ink;
    const n = grid.length, gap = cell > 3 ? 1 : 0;
    for (let row = 0; row < n; row++) {
      ctx.globalAlpha = 0.08 + (row / n) * 0.62;      // old lines fade as they rise
      const g = grid[row], y = row * cell;
      for (let i = 0; i < COLS; i++) if (g[i]) ctx.fillRect(i * cell, y, cell - gap, cell - gap);
    }
    ctx.globalAlpha = 1;
  }

  let timer = 0;
  const tick = () => { step(); draw(); };
  function start() { if (REDUCED || timer) return; timer = setInterval(tick, ROW_MS); }
  function stop() { clearInterval(timer); timer = 0; }
  const ro = new ResizeObserver(size); ro.observe(host);
  const theme = new MutationObserver(draw); theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const scheme = matchMedia("(prefers-color-scheme: dark)"); scheme.addEventListener?.("change", draw);
  const onVis = () => { if (document.hidden) stop(); else if (cv.isConnected && wanted) start(); };
  document.addEventListener("visibilitychange", onVis);
  let wanted = false;
  size();
  return {
    start() { wanted = true; start(); },
    stop() { wanted = false; stop(); },
    remove() { wanted = false; stop(); ro.disconnect(); theme.disconnect(); document.removeEventListener("visibilitychange", onVis); cv.remove(); label.remove(); host.classList.remove("fx-ca-host"); },
  };
}
