# Alfred's apps

James's personal habit apps, hosted on GitHub Pages with data synced through Supabase.

| Page | What it is | Store name |
| --- | --- | --- |
| `index.html` | Alfred's Study: the hub, today's note and a "This week" summary | (reads the others) |
| `ledger.html` | The Daily Ledger: habits, points, the store | `ledger` |
| `focus.html` | The Focus Room: timer, soundscapes, focus log | `focus` |
| `shutdown.html` | Sunday Shutdown: the weekly review | `shutdown` |

## How the data works

- One Supabase table, `app_data` (see `supabase/schema.sql`): a row per item, keyed by app and key
  (e.g. `ledger` / `days/2026-11-02`), private to the signed-in owner by row-level security.
- `js/sync.js` keeps a copy of each app's items on the device, queues changes made offline,
  and syncs with Supabase (live updates via Realtime) once signed in.
- `js/compat-db.js` gives the Ledger and Shutdown the same small `collection` / `doc` API they were written against.
- `js/shell.js` adds the sync-status pill and the account sheet (email-code sign-in, backup export/restore, sign out).
- `sw.js` caches the pages so they open without a connection.

## Setup

1. Run `supabase/schema.sql` in the Supabase SQL editor (or via the Supabase connector).
2. Put the project URL and publishable key in `js/config.js`. Both are public by design; never commit the secret key.
3. Supabase → Authentication → Emails → Magic Link: make the email show `{{ .Token }}` so it carries a code.
4. Supabase → Authentication → URL Configuration: Site URL `https://jamessallee.github.io/alfred-apps/`.
5. GitHub → Settings → Pages: deploy from `main`, root.
6. After the first sign-in, turn off "Allow new users to sign up".

## Updating

Bump `CACHE` in `sw.js` when changing files so devices pick up the new version on the next open.
