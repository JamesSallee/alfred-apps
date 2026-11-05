# Alfred's apps

James's personal habit apps, hosted on GitHub Pages with data synced through Supabase.

| Page | What it is | Store name |
| --- | --- | --- |
| `index.html` | Alfred's Study: the hub, today's note and a "This week" summary | (reads the others) |
| `ledger.html` | The Daily Ledger: habits, points, the store | `ledger` |
| `focus.html` | The Focus Room: timer, soundscapes, focus log | `focus` |
| `shutdown.html` | Sunday Shutdown: the weekly review | `shutdown` |
| `larder.html` | The Larder: shared grocery lists, pantry, cookbook and Claude's meal ideas | `larder` (shared with the household) |
| `desk.html` | The Writing Desk: next post, bank, draft links, idea shelf | `desk` |
| `wardrobe.html` | The Wardrobe: today's outfit, the rail, fit and tailoring, the buying plan, occasions and packing | `wardrobe` |

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
3. Sign-in uses Supabase's standard magic-link email (editing the template needs custom SMTP; if added, include `{{ .Token }}` and the code box works too).
4. Supabase → Authentication → URL Configuration: Site URL `https://jamessallee.github.io/alfred-apps/`.
5. GitHub → Settings → Pages: deploy from `main`, root.
6. After the first sign-in, turn off "Allow new users to sign up".

## The Larder

The one app shared with another person. Everything else stays private to its owner.

- **Sharing.** `supabase/larder.sql` adds `household_members` (owner, member, app). A member reads and writes the
  owner's `larder` rows, and nothing else of theirs. `js/sync.js` treats apps in `SHARED_APPS` this way.
- **Claude.** `supabase/functions/larder-ai` is the only thing that talks to Claude; the API key is a Supabase
  secret and never reaches the pages. Every call is logged in `ai_usage`, and calls stop once the month's cap is spent.
  Recipe links are read for free when the site publishes standard recipe data; Claude only reads the page when it doesn't.
- **Nothing runs on its own.** Claude is only called when someone presses a button.

### Setting it up

1. Run `supabase/larder.sql` in the SQL editor (after `schema.sql`).
2. Add the secrets (Supabase → Edge Functions → Secrets): `ANTHROPIC_API_KEY` (from console.anthropic.com).
   Optional: `LARDER_MONTHLY_CAP_USD` (default `10`, shared with the Wardrobe), `LARDER_MODEL` (default `claude-sonnet-5-5`; `claude-opus-5-5` is about twice the cost).
3. Deploy the function: `supabase functions deploy larder-ai` (or via the Supabase connector).
4. Open the Larder, tap **House rules** and write down tastes, goals and dislikes. They live in the database, not in this repo.

### Inviting a household member

1. Supabase → Authentication → Users → **Invite user** with their email (works with sign-ups switched off).
2. Once they've signed in once, link them (replace both emails):
   ```sql
   insert into public.household_members (owner_id, member_id, app)
   select o.id, m.id, 'larder' from auth.users o, auth.users m
   where o.email = 'OWNER_EMAIL' and m.email = 'MEMBER_EMAIL';
   ```
3. They open `larder.html` and add it to the home screen. They'll see the owner's list from then on.

### Saving recipes from the Share menu

- **Android (Chrome):** open the Larder, then menu → **Install app**. "Larder" then appears in the Share menu;
  sharing a recipe page opens the Larder and saves it.
- **iPhone:** websites can't join the iOS Share menu, so use a Shortcut. In the Shortcuts app: new shortcut →
  turn on **Show in Share Sheet** (accepting URLs and Safari web pages) → add **URL** with
  `https://jamessallee.github.io/alfred-apps/larder.html?url=` followed by the **Shortcut Input** variable → add **Open URLs**.
  Name it "Save to Larder". It opens in Safari, so sign in to the Larder in Safari once as well; the recipe then
  syncs to the home-screen app.

## Updating

Bump `CACHE` in `sw.js` when changing files so devices pick up the new version on the next open.

## The Wardrobe

Private to its owner, like every room except the Larder. Built for a changing size: measurements once a month,
a fit verdict on every piece, a tailoring list, and a buying plan that waits on anything worth investing in.

- **Photos.** Each piece's 480 px thumbnail goes to a private Storage bucket (`wardrobe/<user id>/<piece id>.jpg`),
  readable only by its owner, and is cached on the device so the rail works offline. The bigger photo sent to
  Claude for tagging is not kept.
- **Claude.** The `w_*` actions live in `supabase/functions/larder-ai/wardrobe.ts` and share the Larder's key,
  usage log and monthly cap. Household members can't call them.
- **Weather** comes from Open-Meteo (no key), for the town chosen on the Today tab.
- **Work stays out.** Occasions are a date and a dress level (Casual, Family holiday, Business casual, Formal); nothing else is asked.

### Setting it up

1. Run `supabase/wardrobe.sql` in the SQL editor (it creates the private `wardrobe` bucket and its policies).
2. Redeploy the function: `supabase functions deploy larder-ai` (it now includes `wardrobe.ts`).
3. If `LARDER_MONTHLY_CAP_USD` is set as a secret, change it to `10`; if not, the new default is `10`.
