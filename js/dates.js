// Dates as "YYYY-MM-DD" strings in local time, the way every room keys its days.
// Pure functions only, so tests can run them without a browser.

export const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
export const mondayOf = (s) => { const d = parse(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
export const today = () => ymd(new Date());
