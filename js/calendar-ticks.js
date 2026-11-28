// What a tick on a calendar job does to the Errand Book, shared by the Ledger and the console so both pages
// write exactly the same records. The caller owns the day doc: it passes a copy in and saves it afterwards.
//
//   const r = tickJob({ item, body, todo, tasksById, day, on });
//   r.error === "elsewhere"  -> it was ticked in the Errand Book itself; untick it there
//   otherwise save `body` (its jobs map has changed); r.undone, r.tasks, r.left describe what happened

import { jobKey, tasksToFinish } from "./calendar.js";
import { nextRepeat } from "./rooms.js";

export const newTaskId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export function tickJob({ item, body, todo, tasksById, day, on }) {
  body.jobs = { ...(body.jobs || {}) };
  const k = jobKey(item);
  if (on) {
    const job = body.jobs[k];
    if (!job) return { error: "elsewhere" };
    for (const t of job.tasks || []) {
      if (t.made) todo.remove("tasks/" + t.id);
      else { const x = tasksById[t.id]; if (x) todo.set("tasks/" + t.id, { ...x, status: "todo", doneAt: null, calEvent: null }); }
      if (t.next) todo.remove("tasks/" + t.next);
    }
    delete body.jobs[k];
    return { undone: true };
  }
  const at = new Date().toISOString(), tasks = [];
  if (item.kind === "plus") {
    const id = newTaskId();
    todo.set("tasks/" + id, { id, title: item.title, area: "", priority: "Normal", status: "done", doneAt: at, created: at, size: item.minutes || null, source: "calendar", calEvent: item.eventId });
    tasks.push({ id, made: true });
  } else {
    for (const id of tasksToFinish(item, body)) {
      const x = tasksById[id]; if (!x || x.status === "done") continue;
      todo.set("tasks/" + id, { ...x, status: "done", doneAt: at, wantsSlot: false, calEvent: item.eventId });
      const next = nextRepeat(x, day); let nid = null;
      if (next) { nid = newTaskId(); todo.set("tasks/" + nid, { id: nid, ...next }); }
      tasks.push({ id, next: nid });
    }
  }
  body.jobs[k] = { pts: item.points, title: item.title, event: item.eventId, tasks, at };
  if (body.cal) { body.cal = { ...body.cal }; delete body.cal[item.eventId]; }
  return { tasks, left: item.kind === "task" && !tasks.length };
}

/** Tick an errand that has no calendar block (the console's "Any time" list): done in the Errand Book, and the
 *  next copy made if it repeats. Returns { next } so the caller can undo with untickTask. */
export function tickTask({ todo, task, day }) {
  const at = new Date().toISOString();
  todo.set("tasks/" + task.id, { ...stripId(task), status: "done", doneAt: at, wantsSlot: false });
  const next = nextRepeat(task, day); let nid = null;
  if (next) { nid = newTaskId(); todo.set("tasks/" + nid, { id: nid, ...next }); }
  return { next: nid };
}
/** Undo tickTask: the errand open again, and the repeat it made removed. */
export function untickTask({ todo, task, next }) {
  todo.set("tasks/" + task.id, { ...stripId(task), status: "todo", doneAt: null });
  if (next) todo.remove("tasks/" + next);
}
const stripId = ({ id, ...rest }) => rest;
