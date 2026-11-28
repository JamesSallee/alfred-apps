// The day's progress as an aquarium (James, 28 Nov 2026; replaces the Growing Vine): a fish or a plant arrives for
// each habit or calendar job ticked, and a golden fish when everything's done. The tank itself is the Study Aquarium
// (js/vendor/study-aquarium.js, MIT, supplied by James); this wraps it for the Study:
//   • it takes the page's own colours, so it sits in the light, dark and night themes like everything else;
//   • the tank holds 25 at most, so a bigger day is scaled to fit (a full day still shows as full);
//   • a caption on the tall tank ("12 of 19 done"), and the weekday's tank changes at midnight;
//   • the fish swim gently (James asked for it), except while paused (the console's dim night clock).
//
//   import { mountAquarium } from "./js/fx-aquarium.js";
//   const tank = mountAquarium();            // { el, set, pause }; mountAquarium({ mini: true }) for the 46px strip
//   someContainer.prepend(tank.el);          // the element survives re-renders: move it, don't rebuild it
//   tank.set(3, 11);                         // 3 of 11 ticked

import { mount } from "./vendor/study-aquarium.js";

const MAX = 25;
const CSS = `
.fx-aquarium{position:relative;flex:none;border-radius:14px;overflow:hidden;
  --ag:var(--green);--ab:var(--brass);--ap:var(--paper);--ax:var(--bg)}
.fx-aquarium.mini{border-radius:10px}
.fx-aquarium>div{--ag:inherit;--ab:inherit;--ap:inherit;--ax:inherit}
.fx-aquarium .cap{position:absolute;left:14px;bottom:12px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--green);background:color-mix(in srgb,var(--paper) 85%,transparent);padding:3px 8px;border-radius:999px;pointer-events:none}
.fx-aquarium.mini .cap{display:none}
`;
const weekday = () => (new Date().getDay() + 6) % 7; // Monday 0, as the tank counts

/** Fit a day bigger than the tank: 30 of 40 becomes 19 of 25, and only a finished day fills it. */
export function fitToTank(done, total) {
  total = Math.max(0, total | 0); done = Math.max(0, Math.min(done | 0, total));
  if (total <= MAX) return [done, total];
  const d = done >= total ? MAX : Math.min(MAX - 1, Math.round((done / total) * MAX));
  return [d, MAX];
}

export function mountAquarium({ mini = false } = {}) {
  if (!document.getElementById("fx-aquarium-css")) {
    const st = document.createElement("style"); st.id = "fx-aquarium-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  const el = document.createElement("div");
  el.className = "fx-aquarium" + (mini ? " mini" : "");
  const tank = mount({ mini, motion: "ambient" });
  el.appendChild(tank.el);
  const cap = Object.assign(document.createElement("span"), { className: "cap" });
  el.appendChild(cap);
  let day = weekday(), paused = false;
  const today = () => { const w = weekday(); if (w !== day) { day = w; tank.setWeekday(w); } };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) today(); });

  /** `d` of `t` ticked. */
  function set(d, t) {
    today();
    const total = Math.max(0, t | 0), done = Math.max(0, Math.min(d | 0, total));
    tank.set(...fitToTank(done, total));
    cap.textContent = total ? (done >= total ? "Day complete" : `${done} of ${total} done`) : "Waiting for today";
    el.setAttribute("aria-label", total ? `An aquarium: ${done} of ${total} done${done >= total ? ", day complete" : ""}` : "An empty aquarium");
    tank.el.removeAttribute("aria-label"); tank.el.setAttribute("aria-hidden", "true"); el.setAttribute("role", "img");
  }
  /** Stop the swimming (true) or let it carry on (false). */
  function pause(on) { if (on === paused) return; paused = on; tank.setMotion(on ? "event" : "ambient"); }
  return { el, set, pause };
}
