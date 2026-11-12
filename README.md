# Alfred's apps

Personal habit apps, hosted on GitHub Pages with data synced through Supabase.

| Page | What it is | Store name |
| --- | --- | --- |
| `index.html` | Alfred's Study: the hub, today's note and a "This week" summary | (reads the others) |
| `console.html` | The Study's tablet console: an always-on landscape view (clock, today's note, the next Focus Plan blocks, a Focus Room timer, today's Ledger, errands, the week, every room) | (reads the others; logs to `focus`, ticks `ledger`) |
| `ledger.html` | The Daily Ledger: habits, points, and the fun-money store (points unlock spending; sums in `js/money.js`, one-off data change in `supabase/ledger-money.sql`) | `ledger` |
| `focus.html` | The Focus Room: timer, soundscapes, focus log | `focus` |
| `shutdown.html` | Sunday Shutdown: the weekly review | `shutdown` |
| `larder.html` | The Larder: shared grocery lists, pantry, cookbook and Claude's meal ideas | `larder` (shared with the household) |
| `desk.html` | The Writing Desk: Coming up (next post opened out; dates follow the publish date), bank, idea shelf, and a collapsed Everything list | `desk` |
| `wardrobe.html` | The Wardrobe: today's outfit, the rail, a dressing board and saved looks, fit and tailoring, the buying plan, occasions and packing | `wardrobe` |
| `todo.html` | The Errand Book: to-dos by Today / This week / Later / Someday, snooze, waiting on, done shelf, slot requests | `todo` |
| `podcast.html` | The Recording Booth: podcast episodes from plan to publish, stage checklists, the music licence log and the credits | `podcast` |
| `reading.html` | The Reading Room: a bookcase of things to read (shelves by length, swiping sideways), a cabinet of curiosities in broad drawers, the attic (untouched for 60 days) and the read pile. Saved from the Chrome extension in `extension/` or Android's Share menu | `reading` |
| `training.html` | The Training Room: Peloton classes, the weights per move, lift progress, rides and the 4/2/1 week | `training` |

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
7. After the Larder is set up (below), run `supabase/allow-list.sql` and redeploy `larder-ai` and `peloton`.

## Who can get in

The pages themselves are public (GitHub Pages), but they hold no data: everything lives in Supabase behind sign-in.

- **Per-owner rules.** Each account sees only its own rows; a Larder household member also sees the owner's `larder` rows.
- **The allow-list** (`supabase/allow-list.sql`). Only accounts in `allowed_users` can read or write any table or photo,
  or call `larder-ai` and `peloton` (`alfred-notion` is the owner's only already). It is keyed by account id, so no
  addresses live in this repo. A stranger who somehow made an account would see nothing and spend nothing.
- **No new accounts.** A trigger on `auth.users` refuses every sign-up unless that email is in `signup_passes` first.
  To add someone: insert their email (lower case) into `signup_passes`, invite them, add their id to `allowed_users`
  (and `household_members` if they share the Larder), then delete the pass.
- The Notion copies, the weekly backup and pg_cron use the service role and the cron secret, so the list doesn't touch them.

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

1. Add a pass first (`insert into public.signup_passes (email) values ('member_email');`, lower case), then
   Supabase → Authentication → Users → **Invite user** with their email.
2. Once they've signed in once, link them (replace both emails):
   ```sql
   insert into public.household_members (owner_id, member_id, app)
   select o.id, m.id, 'larder' from auth.users o, auth.users m
   where o.email = 'OWNER_EMAIL' and m.email = 'MEMBER_EMAIL';
   ```
   Then put them on the allow-list and delete the pass:
   ```sql
   insert into public.allowed_users (user_id) select id from auth.users where email = 'MEMBER_EMAIL';
   delete from public.signup_passes where email = 'member_email';
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

## The Errand Book and the Notion copies

- **Alfred files tasks from chat** straight into `todo` / `tasks/<id>` and, once a slot is on the calendar, sets
  `booked: { start, end }`. Quick capture in the room flags a task `triage` and `wantsSlot` for him to pick up.
- **One-way copies to Notion.** `supabase/functions/alfred-notion` copies Errand Book changes to Notion Tasks and
  Writing Desk changes to the "Writing Desk" database under the ILKWIM Writing Plan. The rooms are the master; edits
  made in Notion are overwritten. Each page nudges a copy a few seconds after an edit, and pg_cron runs one hourly.
  Which Notion page belongs to which item is kept under the app `notion` (`todo/<id>`, `desk/<id>`, `state`).
- **Weekly backup.** Every Sunday 08:00 UTC the same function attaches the full Export JSON (all rooms, no photos)
  to the "Alfred backups" page in Notion. Restore it from any room's account sheet. The scheduled calls also keep the
  free Supabase project from pausing.

### Setting it up

1. Notion → Settings → Connections → Develop or manage integrations → new internal integration. Copy its secret.
2. Share Home with the integration (••• → Connections), so it reaches Tasks, the Writing Desk database and Alfred backups.
3. Supabase → Edge Functions → Secrets: `NOTION_TOKEN` = that secret.
4. Run `supabase/notion.sql` with its placeholders filled in, and deploy with `supabase functions deploy alfred-notion --no-verify-jwt`.

## How the rooms connect

`js/rooms.js` holds the joins; each room still owns its own store.

- **Training Room → Ledger.** A Peloton class from the last 14 days ticks that day's workout habit
  (strength wins a day with two classes, then cardio, then yoga). A day already ticked by hand is left alone,
  and each class is marked `training` / `ticked/<workout id>`, so unticking it in the Ledger sticks.
  It runs in the Ledger and the Training Room, only after both have synced; the Ledger also fetches from
  Peloton on open (at most every 30 minutes).
- **Focus Room → Writing Desk.** A session labelled Writing is logged with the ILKWIM post it was for
  (`piece` on the focus log entry): the next post by default, or another chosen under the labels. The Desk adds it up per post.
  The same session ticks the Ledger's Write habit for its day, once (marked `focus` / `ticked/<t>`, so an untick sticks).
- **Ledger → Sunday Shutdown.** The Shutdown opens with the week in figures (habits, workout mix, focus and
  writing time, lifts whose best this week beat their last weight), adds them to the note for Alfred and saves them with the record.
- **Alfred → Sunday Shutdown (the work week).** The Load Profile usually comes in on Thursday or Friday and Alfred books the week
  then, filing the Focus Plan at `plans/<Monday>` in the `shutdown` app: `{ week, focusPlan, plannedAt, afterHours?, by: "alfred", blocks }`
  (`focusPlan` must start `FOCUS PLAN`; `blocks` is `[{ day: "YYYY-MM-DD", id, start: "HH:MM", end: "HH:MM", overflow }]` in 24-hour time,
  and the console falls back to reading the text when it's missing: see `js/study.js`). Step 5 of the Shutdown shows that plan with its blocks, after-hours hours and anything unplaced.
  Only when there's no plan for the coming week does it give the copy-ready request for Work Claude, a box for the profile
  (it rides along in the note for Alfred, never saved), "No work next week", and a fallback to paste a Focus Plan by hand.
  The shutdown record keeps `work`: `planned` | `none` | `profile` | `waiting`.
- **The Study.** Each door shows one live figure in place of its arrow. Today's note and the greeting are built in `js/study.js`,
  shared by the Study and the console.
- **The console.** `console.html` is for a 10-inch tablet in landscape, kept on in a kiosk browser. It runs its own Focus Room
  timer (not synced live: a session belongs to the device it started on) with the Focus Room's sounds from `js/focus-core.js`,
  logs to the same focus log, and keeps a running session in local storage so a reload picks it up. Light from 7:00 to the day's
  hard stop (from the Focus Plan, else 17:00), dark after, a dim clock from 22:30 to 6:30 (a tap wakes it for 30 seconds).
  It nudges the layout a few pixels each hour against burn-in and reloads itself when `sw.js` changes, never mid-session.
  `console.webmanifest` makes Chrome's "Add to Home screen" open it full screen and landscape, with no address bar.
  To check it in a desktop browser at 1280×800: `console.html?at=2026-11-09T14:32&theme=light` (or `dark`, `night`).

## How the pages are put together

There is no build step: each page is plain HTML with its own `<style>` and `<script type="module">`, served as it is.

- `css/base.css` holds the palette (light and dark), the type and the handful of rules every room shares. Each page links it
  just before its own `<style>`, which keeps the room's layout and anything it does differently. A page that needs a colour
  of its own sets it in its own `:root` block.
- `js/registry.js` is the one list of rooms (name, page, store, the Study's blurb). The Study's doors, the console's room bar
  and Export backup read it.
- `js/ui.js` has the small helpers (`esc`, `byId`, `qs`); `js/dates.js` has the `YYYY-MM-DD` date helpers.

### Adding a room

1. Make `<room>.html`, linking `css/base.css` and mounting the shell with `mountShell("<store>")`.
2. Add it to `ROOMS` in `js/registry.js` (and `CONSOLE_ORDER` if it belongs on the console), and its icon to `js/icons.js`.
3. Add the page to `SHELL` in `sw.js`, bump `CACHE`, and add a row to the table at the top of this file.

`node --test` fails if step 2 or 3 is forgotten.

## Checks

`node --test` (Node 22, nothing to install) runs `tests/`: the fun-money sums, reading a Focus Plan, the Peloton and
Writing auto-ticks, the errand buckets, and that the registry, `sw.js` and this README agree. GitHub runs them on every
pull request, along with `scripts/check-cache-bump.js`, which fails if a cached file changed without a new `CACHE`.

## Updating

Bump `CACHE` in `sw.js` when changing files so devices pick up the new version on the next open (the pull request check reminds you).

## The Wardrobe

Private to its owner, like every room except the Larder. Built for a changing size: measurements once a month,
a fit verdict on every piece, a tailoring list, and a buying plan that waits on anything worth investing in.

- **Photos.** Each piece's 480 px thumbnail goes to a private Storage bucket (`wardrobe/<user id>/<piece id>.jpg`),
  readable only by its owner, and is cached on the device so the rail works offline. The bigger photo sent to
  Claude for tagging is not kept.
- **Claude.** The `w_*` actions live in `supabase/functions/larder-ai/wardrobe.ts` and share the Larder's key,
  usage log and monthly cap. Household members can't call them.
- **Looks.** The dressing board lays pieces from the rail on a figure (coat, jacket, shirt, tie, trousers, belt,
  shoes); Alfred gives a verdict and one swap. Saved looks and 👍/👎 on his outfits feed back into every later suggestion.
- **Fit by photo.** A photo of him wearing a piece gets a fit verdict on the clothes (never the body); the photo isn't
  kept. Pieces are flagged for a re-check once he's 10 lb lighter than when they were last checked.
- **Weather** comes from Open-Meteo (no key), for the town chosen on the Today tab.
- **Work stays out.** Occasions are a date and a dress level (Casual, Family holiday, Business casual, Formal); nothing else is asked.

### Setting it up

1. Run `supabase/wardrobe.sql` in the SQL editor (it creates the private `wardrobe` bucket and its policies).
2. Redeploy the function: `supabase functions deploy larder-ai` (it now includes `wardrobe.ts`).
3. If `LARDER_MONTHLY_CAP_USD` is set as a secret, change it to `10`; if not, the new default is `10`.

## The Training Room

Peloton classes come in on their own; you only confirm the weights.

- **Peloton.** There's no public API, so `supabase/functions/peloton` uses the unofficial one (it may break
  without warning). It logs in with the `PELOTON_USERNAME` and `PELOTON_PASSWORD` secrets (a password used
  nowhere else), and only the owner can call it (Larder household members are refused). The password is never
  logged, returned or stored.
- **What's fetched.** Each new workout is saved as `training` / `workouts/<id>`: the class, and for strength
  classes every weighted move with its tier (light, medium, heavy) and time, from the class plan. Heart rate
  comes along when a monitor was connected (the Pixel Watch reaches Peloton, so no Strava). Cardio is kept only when it is a spin class (no walks, swims, runs or outdoor rides), and rides add total output, average watts and time in each power zone.
- **What you add.** `log/<workout id>`: the weight (and, optionally, reps) per move and tier, pre-filled
  from last time. `settings.kit` holds the dumbbells he owns.
- **Fetching.** On opening the page (at most every 30 minutes) or with **Fetch from Peloton**. Only the last
  14 days are fetched, and only those classes ask for weights; older history isn't worth remembering weights for.
- **Muscle balance.** Peloton scores how much each class worked each muscle group. The page folds those into
  legs, core, push and pull for the last 14 days, and Alfred mentions any region under 15%.

### Setting it up

1. Add the secrets (Supabase → Edge Functions → Secrets): `PELOTON_USERNAME`, `PELOTON_PASSWORD`.
2. Deploy the function: `supabase functions deploy peloton` (or via the Supabase connector).

## The Recording Booth

The podcast's workbench: a monthly radio half hour (four songs played whole, spoken links between them), published in ILKWIM.

- **Episodes** (`podcast` / `episodes/<id>`) move through Plan, Record, Edit, Publish and Out, each with its own checklist
  (editable in `settings.checklists`; ticks are kept per stage on the episode).
- **Running order** (`slots` on the episode): songs from the licence log and spoken links, each timed, with a total kept
  against the running time (30 minutes unless set). Music under or around the talking (theme, stings, beds) is `uses`.
- **The crate** holds songs found but not yet checked (`tracks/<id>` with `found: true`): a link and a note. "Log it" opens
  the track sheet; once saved it leaves the crate for the licence log.
- **The licence log** (`tracks/<id>`) holds each track once: title, artist, source link, licence and version, length, the date
  downloaded, and a link to proof of the licence as it was then.
- **Checks.** Songs in the running order play whole, so ND and SA are fine there. Theme, stings and beds are changes: ND tracks
  can't be used that way, SA tracks make the episode share-alike (two different SA licences can't be mixed), and NC tracks are
  flagged while the show might earn money (`settings.paid`, on by default).
- **Output.** Show notes (plain for Substack, or HTML), a cue sheet with start times and a back-announcement after each song,
  and a credits roll for the sign-off.

## How the Booth and the Desk connect

- **Ideas** stay in the Writing Desk; an episode links to one (`piece`).
- **Link scripts** are Desk pieces too. Adding a link in the running order can create a comedy piece in the Desk, and the
  running order shows its stage and writing time.
- **The Desk** tags any piece an unfinished episode uses ("On air · Ep 3 link"), linking to `podcast.html?ep=<id>`.
- **The Focus Room** lists link scripts in its writing picker, so writing time lands on the right piece and ticks Write.
- The joins are `onAir` and `radioScripts` in `js/rooms.js`.
