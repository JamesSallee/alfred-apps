// The Wardrobe's Claude actions. Private to the owner (index.ts refuses w_* calls from household members).
// Everything the page sends is a compact summary of James's own rail and measurements; nothing is stored here.
//
//   w_tag        { image, media_type }                                -> what the piece is (type, colour, formality…)
//   w_outfit     { rail, weather, level, note, style, recent }        -> two outfits for today from owned pieces
//   w_fit        { rail, measures, target, sizes }                    -> current sizes + tailor / replace verdicts
//   w_gap        { rail, phase, levels, occasions, style, measures }  -> a lean, ranked buying list
//   w_before_buy { image?, text, price, size, rail, phase }           -> buy, wait or skip
//   w_style      { profile, measures, rail }                          -> a personal style brief
//   w_occasion   { kind, level, days, nights, weather, note, rail }   -> an outfit for an event, or a packing list for a trip

type Usage = { input: number; output: number; searches: number };
type Result = { result: Record<string, unknown>; usage?: Usage };
type Handler = (b: Record<string, unknown>, guard: () => void) => Promise<Result>;
type Tools = {
  // deno-lint-ignore no-explicit-any
  ask: (p: { content: any; schema?: Record<string, unknown>; effort?: "low" | "medium" | "high"; system?: string; maxTokens?: number }) =>
    Promise<{ text: string; usage: Usage }>;
  // deno-lint-ignore no-explicit-any
  parseJson: (t: string) => any;
  photoOf: (b: Record<string, unknown>) => { data: string; media: "image/jpeg" | "image/png" | "image/webp" | "image/gif" };
  fail: (status: number, msg: string) => Error;
};

const VALET = `You are Alfred, a calm, dry, kindly gentleman's butler who also acts as a discreet valet and personal stylist
for one man, James. He is losing weight towards a target, so his sizes are changing; he wants to look sharp without
wasting money on clothes he will soon outgrow. He dresses for four levels: Casual, Family holiday, Business casual,
and Formal (official occasions). Use British spelling. Keep prose short and warm, with at most a dash of dry wit.
Give concrete, practical advice (colours, fits, what goes with what, what a tailor can and cannot fix).
Never ask about or mention his work beyond "formal" or "official" occasions. Only refer to pieces by the ids given.`;

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
  ].filter(Boolean).join("\n");
}
const RAIL_HELP = "Rail (one piece per line: id | name | category | colour | formality | labelled size | fit verdict | wears | last worn):";

export function wardrobeHandlers({ ask, parseJson, photoOf, fail }: Tools): Record<string, Handler> {
  const run = async (content: unknown, schema: Record<string, unknown>, effort: "low" | "medium" = "low") => {
    const { text, usage } = await ask({ content, schema, effort, system: VALET });
    return { result: parseJson(text), usage };
  };

  return {
    async w_tag(b, guard) {
      guard();
      const { data, media } = photoOf(b);
      return run([
        { type: "image", source: { type: "base64", media_type: media, data } },
        { type: "text", text: `Catalogue this piece of clothing (or pair of shoes, or accessory). If the photo holds no clothing,
set found=false. "name" is a short everyday name a man would use ("Navy wool suit", "White Oxford shirt").
"size_seen" is the size on a visible label, else "". "care" is your best guess from the fabric.
"pairs_with" is one line of styling advice: what it goes with.` },
      ], obj({
        found: bool, name: str, category: oneOf(...CATEGORIES), colour: str, pattern: str, fabric: str,
        formality: oneOf(...FORMALITY), seasons: arr(oneOf("Spring", "Summer", "Autumn", "Winter")),
        care: oneOf("Machine wash", "Hand wash", "Dry clean", "Polish", "Spot clean"), size_seen: str, pairs_with: str,
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

From his latest measurements, work out his current size for each garment type he owns (e.g. "Dress shirt: 16 / 34",
"Trousers: 34W 32L", "Jacket: 42R"), noting how they differ from the labelled sizes on the rail.
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
