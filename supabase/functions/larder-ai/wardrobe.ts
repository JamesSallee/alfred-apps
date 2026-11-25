// The Wardrobe's Claude actions. Private to the owner (index.ts refuses w_* calls from household members).
// Everything the page sends is a compact summary of the owner's own rail and measurements; nothing is stored here.
//
//   w_tag        { image, media_type }                                -> what the piece is (type, colour, formality…)
//   w_outfit     { rail, weather, level, note, style, recent }        -> two outfits for today from owned pieces
//   w_fit        { rail, measures, target, sizes }                    -> current sizes + tailor / replace verdicts
//   w_gap        { rail, phase, levels, occasions, style, measures }  -> a lean, ranked buying list
//   w_before_buy { image?, text, price, size, rail, phase }           -> buy, wait or skip
//   w_style      { profile, measures, rail }                          -> a personal style brief
//   w_occasion   { kind, level, days, nights, weather, note, rail }   -> an outfit for an event, or a packing list for a trip
//   w_fit_photo  { image, piece, measures }                           -> does this piece fit him, judged from a photo of him in it
//   w_look       { look, photos, level, weather, rail, liked }        -> does this combination work (judged from photos), and one swap
//   w_selfie     { image, rail, judge, level, weather }               -> which rail pieces he's wearing in a selfie (+ optional verdict)
//   w_find       { item, why, budget, where, when }                   -> real listings on the web for a buying-list item

type Usage = { input: number; output: number; searches: number };
type Result = { result: Record<string, unknown>; usage?: Usage };
type Handler = (b: Record<string, unknown>, guard: () => void) => Promise<Result>;
type Tools = {
  // deno-lint-ignore no-explicit-any
  ask: (p: { content: any; schema?: Record<string, unknown>; tools?: any[]; effort?: "low" | "medium" | "high"; system?: string; maxTokens?: number }) =>
    Promise<{ text: string; usage: Usage }>;
  // deno-lint-ignore no-explicit-any
  parseJson: (t: string) => any;
  photoOf: (b: Record<string, unknown>) => { data: string; media: "image/jpeg" | "image/png" | "image/webp" | "image/gif" };
  fail: (status: number, msg: string) => Error;
};

const VALET = `You are Alfred, a calm, dry, kindly gentleman's butler who also acts as a discreet valet and personal stylist
for one man. He is losing weight towards a target, so his sizes are changing; he wants to look sharp without
wasting money on clothes he will soon outgrow. He dresses for four levels: Casual, Family holiday, Business casual,
and Formal (official occasions). Each piece may also carry style tags (Casual, Smart casual, Business casual, Formal,
Active & outdoor, Lounge, Travel, Conference, Game day, Gig & record shop, Yard & DIY, Occasion). Use British spelling. Keep prose short and warm, with at most a dash of dry wit.
Give concrete, practical advice (colours, fits, what goes with what, what a tailor can and cannot fix).
Never ask about or mention his work beyond "formal" or "official" occasions. Only refer to pieces by the ids given.
Each piece's name starts with its number ("No. 47 Olive cotton chinos"), which is also written on the piece in his app.
When you mention a piece in prose, include its number, e.g. "the olive chinos (No. 47)", so he knows which one you mean.`;

const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const bool = { type: "boolean" };
const obj = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items: unknown) => ({ type: "array", items });
const oneOf = (...e: string[]) => ({ type: "string", enum: e });

export const CATEGORIES = ["Suit", "Blazer", "Jacket", "Coat", "Dress shirt", "Casual shirt", "Polo", "T-shirt", "Knitwear",
  "Trousers", "Chinos", "Jeans", "Shorts", "Shoes", "Tie", "Belt", "Accessory", "Activewear", "Swimwear", "Other"];
export const FORMALITY = ["Casual", "Smart casual", "Business casual", "Formal"];
const LEVELS = ["Casual", "Family holiday", "Business casual", "Formal"];
const VERDICTS = ["Fits", "Tailor", "Too big", "Too small", "Retire", "Donate"];
// Style tag ids, as wardrobe.html's STYLES has them.
export const STYLES = ["casual", "smart", "business", "formal", "active", "lounge", "travel", "conference", "gameday", "gig", "yard", "occasion"];

// Clip what the page sends, so a mistaken payload can't run up the bill.
const clip = (x: unknown, n: number) => String(x ?? "").slice(0, n);
const lines = (x: unknown, max = 260) =>
  (Array.isArray(x) ? x.slice(0, max).map((l) => clip(l, 200)).join("\n") : "") || "none";

function about(b: Record<string, unknown>) {
  return [
    b.measures ? `Measurements (newest first):\n${lines(b.measures, 6)}` : "",
    b.target ? `Target: ${clip(b.target, 200)}` : "",
    b.sizes ? `Current sizes: ${clip(b.sizes, 600)}` : "",
    b.phase ? `Size phase: ${clip(b.phase, 60)}` : "",
    b.style ? `His style brief: ${clip(b.style, 1500)}` : "",
    b.liked ? `Combinations he liked:\n${lines(b.liked, 15)}` : "",
    b.disliked ? `Combinations he didn't like:\n${lines(b.disliked, 10)}` : "",
  ].filter(Boolean).join("\n");
}
const RAIL_HELP = "Rail (one piece per line: id | name | category | colour | formality | labelled size | fit verdict | wears | last worn | styles):";

export function wardrobeHandlers({ ask, parseJson, photoOf, fail }: Tools): Record<string, Handler> {
  const run = async (content: unknown, schema: Record<string, unknown>, effort: "low" | "medium" = "low") => {
    const { text, usage } = await ask({ content, schema, effort, system: VALET });
    return { result: parseJson(text), usage };
  };

  return {
    async w_fit_photo(b, guard) {
      guard();
      const { data, media } = photoOf(b);
      return run([
        { type: "image", source: { type: "base64", media_type: media, data } },
        { type: "text", text: `${about(b)}
The piece he is wearing in this photo: ${clip(b.piece, 300)}

Judge how this piece fits him as a tailor would at a fitting: shoulders, chest, waist, sleeve or leg length, collar,
seat and break, whichever apply. If the photo doesn't show the piece clearly enough to judge, set can_judge=false
and say what photo would help in "advice". Otherwise give a verdict. "notes" are short observations, one per area
("Shoulders: about an inch too wide"). For Tailor, describe the alteration as you would to a tailor and estimate a
cost in USD. Remember he is still losing weight: say when it is wiser to wait than to tailor now.
Be kind but candid. Comment only on the fit of the clothes, never on his body.` },
      ], obj({ can_judge: bool, verdict: oneOf(...VERDICTS), notes: arr(str), advice: str, alteration: str, cost_usd: num }), "medium");
    },

    async w_selfie(b, guard) {
      guard();
      // A photo of him dressed for the day. Alfred finds each piece on the rail so the wear can be logged, and,
      // if asked, judges the outfit as actually worn. The photo is not stored anywhere.
      const { data, media } = photoOf(b);
      const judge = b.judge === true;
      return run([
        { type: "image", source: { type: "base64", media_type: media, data } },
        { type: "text", text: `${about(b)}
${judge ? `Dress level today: ${clip(b.level, 40) || "unknown"}\nWeather: ${clip(b.weather, 300) || "unknown"}\n` : ""}
${RAIL_HELP}
${lines(b.rail)}

The photo shows him wearing today's clothes, often as a mirror selfie (so left and right may be flipped, and the
phone may hide part of him). Work out which pieces from the rail he is wearing.
- "items": one entry per garment or accessory you can see, top to bottom. "what" is a short plain description of
  what you see ("Grey quarter-zip jumper") and "kind" the rail category it belongs to. "x" and "y" give the centre of that garment in the photo, as
  percentages of the photo's width and height (0 to 100). "candidates" are up to three rail ids that could be it,
  best first, or [] if nothing on the rail matches. "sure" is Sure when only one rail piece could be it, Likely
  when the first is clearly favoured, Unsure when two or more look alike from here (then list them all).
- A piece that is partly hidden (a shirt under a jumper, showing at the collar and cuffs) still counts if you can
  see enough of it to tell.
- "unseen": kinds of piece he is almost certainly wearing that the photo doesn't show (usually Shoes, often Belt),
  each with up to three rail ids that would most sensibly go with this outfit, best first. Don't include kinds he
  may well not be wearing (a tie, a hat).
- If the photo doesn't show his clothes well enough to tell, set can_see=false and say in "advice" what photo
  would work; otherwise advice is "".
${judge ? `Then judge the outfit as worn, as a fashion-conscious valet would at the door. Consider colour and contrast,
pattern and texture, formality for the level and the weather, and proportion: sleeve and trouser length, the break
over the shoes, layering lengths, how each piece sits on him. "verdict" is Works, Nearly or Rethink; be honest and
don't call something Works out of politeness. "comment" is two sentences at most, in Alfred's voice, naming the
specific thing that works or jars. "fixes" are up to three small, concrete changes, naming a rail piece by its
number where one would help ([] if it's right as it is). Comment only on the clothes and how they fit, never on
his body.` : `Don't judge the outfit: verdict "", comment "" and fixes [].`}` },
      ], obj({
        can_see: bool, advice: str,
        items: arr(obj({ what: str, kind: oneOf(...CATEGORIES), x: num, y: num, candidates: arr(str), sure: oneOf("Sure", "Likely", "Unsure") })),
        unseen: arr(obj({ kind: oneOf(...CATEGORIES), candidates: arr(str) })),
        verdict: oneOf("Works", "Nearly", "Rethink", ""), comment: str, fixes: arr(str),
      }), judge ? "medium" : "low");
    },

    async w_find(b, guard) {
      guard();
      // Real listings for one item on his buying list, found with web search. Only pages actually found are kept.
      const budget = Number(b.budget) || 0;
      const { text, usage } = await ask({
        system: VALET,
        effort: "medium",
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }],
        content: `${about(b)}

He wants to buy: ${clip(b.item, 200)}
Why: ${clip(b.why, 300) || "a gap in his wardrobe"}
Budget: ${budget ? `about $${budget}` : "sensible"}${clip(b.when, 10) === "Wait" ? " (he means to wait, so only a real bargain is worth flagging)" : ""}
Where Alfred suggested looking: ${clip(b.where, 120) || "anywhere sensible"}

Find 3 to 5 real menswear listings he could buy now, shipping to the USA. Search for the item by its key words and
his label size where it applies (use "Current sizes" above, and treat sizes marked as his own as fact). While he is
still losing weight, put good second-hand or discounted listings first (eBay, Poshmark, Grailed, thredUP, brand
outlets), then sensible new ones. Stay near the budget; one stretch pick is fine if it is clearly better. Respect his
style brief and anything he said he didn't like. Search with a few different wordings rather than one long query.

Only give a url for a product page you actually found in a search result. Never invent prices, sizes or links: say
"" or 0 when a page didn't show them. Answer with only a JSON object, no other prose:
{"note": "<one sentence from Alfred>", "results": [{"title": "<the listing's name>", "url": "", "shop": "",
"price_usd": 0, "size": "<the size on the listing, or empty>", "condition": "<New, Used or Sale>",
"why": "<one line: why this one, for him>"}]}`,
      });
      const out = parseJson(text);
      out.results = (Array.isArray(out.results) ? out.results : [])
        .filter((r: { url?: string }) => /^https:\/\//.test(String(r?.url || "")))
        .slice(0, 5)
        .map((r: Record<string, unknown>) => ({
          title: clip(r.title, 160), url: clip(r.url, 600), shop: clip(r.shop, 60), price_usd: Number(r.price_usd) || 0,
          size: clip(r.size, 40), condition: clip(r.condition, 20), why: clip(r.why, 240),
        }));
      out.note = clip(out.note, 300);
      return { result: out, usage };
    },

    async w_look(b, guard) {
      guard();
      // Up to 10 thumbnails of the pieces on the board, each labelled with its slot, so Alfred judges the real
      // colours, textures and patterns rather than the catalogue's words.
      const content: unknown[] = [];
      const photos = Array.isArray(b.photos) ? b.photos.slice(0, 10) : [];
      for (const ph of photos as Record<string, unknown>[]) {
        const data = String(ph?.image || "");
        const media = String(ph?.media_type || "image/jpeg");
        if (!data || data.length > 600_000 || !/^image\/(jpeg|png|webp)$/.test(media)) continue;
        content.push({ type: "text", text: clip(ph.label, 120) });
        content.push({ type: "image", source: { type: "base64", media_type: media, data } });
      }
      content.push({ type: "text", text: `${about(b)}
Dress level: ${clip(b.level, 40)}
Weather: ${clip(b.weather, 300) || "unknown"}

The combination he is considering (slot: piece line)${content.length ? "; the photos above show each piece" : ""}:
${lines(b.look, 10)}

${RAIL_HELP}
${lines(b.rail)}

Judge this as a fashion-conscious valet would before letting him out of the door. Look at the photos first and
trust them over the catalogue's words where they disagree (a "navy" that is really black, a "plain" shirt with a
fine stripe). Consider:
- Colour: harmony and contrast, warm against cool undertones, how many colours are in play, whether the darkest
  piece sits in the right place (usually the shoes or jacket).
- Pattern and texture: mix pattern scales rather than repeating one; pair smooth with textured; flannel, tweed and
  linen against worsted; season-appropriate cloth for the weather.
- Formality: every piece at the same register, nothing too sporty or too dressy for the level.
- Leather and metal: belt and shoes in the same family; brown versus black for the occasion and the trousers.
- Proportion and details: tie width against lapel, collar style with or without a tie, trouser break and length
  with the shoes, layering lengths.
"verdict" is Works, Nearly or Rethink; be honest, and don't call something Works out of politeness.
"comment" is two sentences at most, in Alfred's voice, naming the specific thing that works or jars.
Suggest the single swap that would most improve it: "swap_out" is the id of a piece in the combination (or ""
to add rather than replace), "swap_in" is the id of a piece from the rail that currently fits (or "" if the
combination is right as it is), and "swap_why" is one line.` });
      return run(content, obj({ verdict: oneOf("Works", "Nearly", "Rethink"), comment: str, swap_out: str, swap_in: str, swap_why: str }), "medium");
    },

    async w_tag(b, guard) {
      guard();
      const { data, media } = photoOf(b);
      return run([
        { type: "image", source: { type: "base64", media_type: media, data } },
        { type: "text", text: `Catalogue this piece of clothing (or pair of shoes, or accessory). If the photo holds no clothing,
set found=false. "name" is a short everyday name a man would use ("Navy wool suit", "White Oxford shirt").
"size_seen" is the size on a visible label, else "". "care" is your best guess from the fabric.
"pairs_with" is one line of styling advice: what it goes with.
"styles" are the occasions it suits; most pieces have two to four. casual: everyday weekends. smart: smart casual and
date night. business: business casual. formal: official occasions. active: walks, gym, hikes, weather layers. lounge:
at home. travel: comfortable, crease-resistant, mix-and-match. conference: tech casual, a sharp layer over jeans.
gameday: Miami Dolphins and other team kit, cold-stadium layers. gig: band tees, denim, jackets with edge. yard: house
projects, clothes he can ruin. occasion: weddings, funerals and holidays.` },
      ], obj({
        found: bool, name: str, category: oneOf(...CATEGORIES), colour: str, pattern: str, fabric: str,
        formality: oneOf(...FORMALITY), seasons: arr(oneOf("Spring", "Summer", "Autumn", "Winter")),
        care: oneOf("Machine wash", "Hand wash", "Dry clean", "Polish", "Spot clean"), size_seen: str, pairs_with: str,
        styles: arr(oneOf(...STYLES)),
      }));
    },

    async w_outfit(b, guard) {
      guard();
      return run(`${about(b)}
Today's weather: ${clip(b.weather, 300) || "unknown"}
Today's dress level: ${clip(b.level, 40)}
${b.note ? `He also said: ${clip(b.note, 300)}` : ""}
Worn in the last few days (avoid repeating): ${clip(b.recent, 600) || "nothing logged"}

${RAIL_HELP}
${lines(b.rail)}

Choose two complete outfits for today from pieces that currently fit (verdict Fits or Tailor-but-wearable; never Too big,
Too small, Retire or Donate). Each outfit lists piece_ids from the rail only. Dress for the weather and the level.
If a sensible outfit needs something he lacks, name it in "missing". "why" is one line of styling reasoning.
"note" is one sentence from Alfred.`,
        obj({ note: str, outfits: arr(obj({ name: str, piece_ids: arr(str), why: str, missing: arr(str) })) }));
    },

    async w_fit(b, guard) {
      guard();
      return run(`${about(b)}

${RAIL_HELP}
${lines(b.rail)}

Work out the size to look for on the label for each garment type he owns (e.g. "Dress shirt: 16 / 34",
"Trousers: 34W 32L", "Jacket: 42R"). Start from the labelled sizes of pieces whose verdict is Fits: those are what
actually fit him. Ready-to-wear labels, waists above all, run smaller than a tape measurement (jeans and trousers
are commonly labelled 2 to 5 inches under the measured waist), so never turn a tape figure straight into a label
size. Use his measurements only for the direction he's heading and to judge pieces with no fit verdict yet.
A current size marked "his own, from the labels" is fact: repeat it unchanged, and flag in the summary if the rail
seems to disagree.
Then list only the pieces whose verdict should change or that need a decision. For each, give a verdict and
practical advice. Rules of thumb: trousers can usually come in up to about 2 inches at the waist; a jacket's
shoulders cannot be made smaller; a shirt with a loose collar should go; knitwear and T-shirts are rarely worth
altering. For Tailor, describe the alteration as you would to a tailor and estimate a cost in USD.
Remember he is still losing weight: say when it is wiser to wait than to tailor now.`,
        obj({ summary: str, sizes: arr(obj({ garment: str, size: str })),
          pieces: arr(obj({ id: str, verdict: oneOf(...VERDICTS), advice: str, alteration: str, cost_usd: num })) }), "medium");
    },

    async w_gap(b, guard) {
      guard();
      return run(`${about(b)}
Dress levels he needs to cover: ${clip(b.levels, 200) || LEVELS.join(", ")}
Upcoming occasions: ${clip(b.occasions, 800) || "none logged"}

${RAIL_HELP}
${lines(b.rail)}

Build a lean buying list: only real gaps, given what fits now. While he is still losing weight, favour cheap,
second-hand, or easily altered pieces and say "Wait" for anything worth investing in at his target size.
Make sure he could always dress for a formal occasion. "priority" 1 is most urgent. "budget_usd" is a sensible
price to pay. "where" is the kind of place to look (e.g. "second-hand / consignment", "high street", "made to measure").
"note" is one or two sentences from Alfred.`,
        obj({ note: str, items: arr(obj({ item: str, why: str, priority: int, when: oneOf("Now", "Wait"), budget_usd: num, where: str })) }), "medium");
    },

    async w_before_buy(b, guard) {
      guard();
      const content: unknown[] = [];
      if (b.image) {
        const { data, media } = photoOf(b);
        content.push({ type: "image", source: { type: "base64", media_type: media, data } });
      }
      content.push({ type: "text", text: `${about(b)}
He is thinking of buying: ${clip(b.text, 400) || "the item in the photo"}${b.price ? `, for $${clip(b.price, 20)}` : ""}${b.size ? `, size ${clip(b.size, 30)}` : ""}

${RAIL_HELP}
${lines(b.rail)}

Should he buy it? "Buy" if it fills a real gap and suits him; "Wait" if it is worth having but better bought at his
target size; "Skip" if it duplicates what he has or doesn't suit. "duplicates" and "pairs_with" are piece ids from the rail.
"reason" is two sentences at most, in Alfred's voice.` });
      return run(content, obj({ verdict: oneOf("Buy", "Wait", "Skip"), reason: str, duplicates: arr(str), pairs_with: arr(str) }));
    },

    async w_style(b, guard) {
      guard();
      return run(`What he has told me about himself: ${clip(b.profile, 1500) || "nothing yet"}
${about(b)}

${RAIL_HELP}
${lines(b.rail)}

Write a personal style brief for him, practical rather than fashionable. Cover colours that suit him (and why),
colours to avoid, fits and cuts that flatter a man whose shape is changing, and a reliable look for each dress level.
"formal" should describe a complete official-occasion outfit (suit colour, shirt, tie, shoes, belt, socks, pocket square).
"rules" are short, memorable rules of thumb. "summary" is two sentences from Alfred.`,
        obj({ summary: str, palette: arr(obj({ colour: str, why: str })), avoid: arr(str), fits: arr(str),
          casual: str, family_holiday: str, business_casual: str, formal: str, rules: arr(str) }), "medium");
    },

    async w_occasion(b, guard) {
      guard();
      const trip = b.kind === "trip";
      return run(`${about(b)}
${trip ? `A trip of ${clip(b.days, 4)} days (${clip(b.nights, 4)} nights). Dress levels on the trip: ${clip(b.level, 120)}.`
    : `An occasion. Dress level: ${clip(b.level, 40)}.`}
Weather expected: ${clip(b.weather, 200) || "unknown"}
${b.note ? `Notes: ${clip(b.note, 400)}` : ""}

${RAIL_HELP}
${lines(b.rail)}

${trip
    ? `Build a packing capsule from pieces that currently fit: as few pieces as possible that mix and match.
"pack" lists each item with its piece_id (or "" for basics he hasn't catalogued, such as socks and underwear) and a qty.
"plan" is one line per day saying what to wear.`
    : `Choose the best outfit from pieces that currently fit. "pack" lists each piece (piece_id, item, qty 1).
"plan" is up to three short lines: grooming, what to check the day before, anything to press or polish.`}
"missing" lists anything he must buy or tailor in time. "note" is one sentence from Alfred.`,
        obj({ note: str, pack: arr(obj({ piece_id: str, item: str, qty: int })), plan: arr(str), missing: arr(str) }));
    },
  };
}
