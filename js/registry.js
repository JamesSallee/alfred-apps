// The one list of Alfred's rooms. Add a room here (and its icon in js/icons.js), and the Study's doors,
// the console's room bar and the account sheet's Export backup all pick it up. Also add the page to SHELL
// in sw.js and a row to the README table; `node --test` checks that neither has been forgotten.

/** In the order of the Study's doors. `store` is the app name its rows use in Supabase (app_data.app). */
export const ROOMS = [
  { id: "ledger",   store: "ledger",   href: "ledger.html",   name: "The Daily Ledger",    short: "Ledger",   desc: "Tick off today's habits and keep the balance honest." },
  { id: "focus",    store: "focus",    href: "focus.html",    name: "The Focus Room",      short: "Focus",    desc: "A timer and a soundscape for writing, piano or code." },
  { id: "shutdown", store: "shutdown", href: "shutdown.html", name: "Sunday Shutdown",     short: "Shutdown", desc: "Close out the week and set up the next, every Sunday evening." },
  { id: "larder",   store: "larder",   href: "larder.html",   name: "The Larder",          short: "Larder",   desc: "The shared grocery list, the pantry, the cookbook and dinner ideas." },
  { id: "desk",     store: "desk",     href: "desk.html",     name: "The Writing Desk",    short: "Desk",     desc: "The next post, the bank, draft links and the idea shelf." },
  { id: "training", store: "training", href: "training.html", name: "The Training Room",   short: "Training", desc: "Peloton classes, the weights you lifted, and whether they're going up." },
  { id: "todo",     store: "todo",     href: "todo.html",     name: "The Errand Book",     short: "Errands",  desc: "Everything that needs doing, when it's booked, and what's waiting." },
  { id: "podcast",  store: "podcast",  href: "podcast.html",  name: "The Recording Booth", short: "Booth",    desc: "Podcast episodes from plan to publish, the music licences and the credits." },
  { id: "wardrobe", store: "wardrobe", href: "wardrobe.html", name: "The Wardrobe",        short: "Wardrobe", desc: "What to wear today, what still fits, the tailor and the formal kit." },
];

/** The console's room bar, busiest first. Rooms not listed here go on the end. */
export const CONSOLE_ORDER = ["ledger", "focus", "todo", "desk", "training", "larder", "podcast", "wardrobe", "shutdown"];

/** Every app whose rows the pages keep: the rooms plus the Study's own notes. Used for Export backup. */
export const DATA_APPS = [...ROOMS.map((r) => r.store), "study"];

export const room = (id) => ROOMS.find((r) => r.id === id);
