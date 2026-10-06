# Article notes — what the reader will stall on

Between trying the two demos on 26th September 2026, the author had to ask for clarification four
times. Each question is recorded here with the answer, because **the author hitting these while
holding full project context is strong evidence a reader will hit them too.** Anything that needed
explaining out loud needs explaining in the article.

This is a checklist for the article, not background reading. Nothing here is optional.

---

## 1. How do I actually run it

Asked twice, once per project. Both times the real question was *"and what do I type to see it
work?"* — a "run `npm run dev`" line is not enough.

```bash
cd ev-charger
npm run dev          # port 3100, deliberately not 3000
```

`npm run start` needs `npm run build` first and is the wrong answer for a reader poking at it.

**For the article:** give the command, the port, and a concrete sentence to paste in. Then name the
one thing to change to see the behaviour flip — set the hour from `21` to `12` and watch Middy's Port
Melbourne move from *ruled out* to *check first*.

## 2. What do the inputs mean, and where is it measuring from

### Arriving (hour)

A 0–23 clock hour — the time you would reach the charger. Code turns it into a **word**, because the
model cannot compare times:

| hour | becomes | time gate fires? |
| --- | --- | :---: |
| 7–16 | `in daylight` | no |
| 17–18 | `around dusk` | **no** |
| 19–23, 0–6 | `after dark` | **yes** |

**Known gap, worth stating in the article rather than hiding:** `around dusk` is not treated as after
dark, so a 6pm arrival at a charger that shut at 5pm gets a warning instead of a refusal. The
coarseness is in our logic, not the model.

### The locations

**Were hardcoded Melbourne CBD → Geelong; now selectable.** See section 7 — this question is what
prompted the change. Fourteen presets, both tagged on the map. The default journey is still
Melbourne CBD (`-37.8136, 144.9631`) → Geelong (`-38.1499, 144.3617`), 64km great-circle.

Not the browser's location and not clickable on the map. Chargers are searched within **40km of the
origin**, up to 400 results, narrowed to **8** before the model is asked anything — so the origin is
the input that changes which chargers exist at all.

## 3. What are the "Code did" and "Jev did" panels

They exist to make the division of labour visible on screen. They are the article's argument rendered
as UI, so the article should probably show a screenshot of them.

**Code did** — every number exact, no model involved:

- `117 chargers → 8 shortlisted` — how many came back from Open Charge Map, and how many survived
  the filter (operational, and physically reachable on the charge you have)
- `48km of usable range` — `12% × 500km × 0.8`. The 0.8 derates a brochure range figure for highway
  speed, cold battery and climate control. Pessimistic on purpose: running flat is a much worse error
  than stopping early.
- `Distance, power, time`

**Jev did** — judgement over prose:

- `28 questions, one request`
- `Read as: safety` — what it decided matters most, from the sentence alone
- `Prose only, no numbers` — literally true, and the claim the whole design rests on

## 4. What ARE the 28 questions

The count alone was not enough. The article needs the real text.

### The three question types, first

| type | returns | for |
| --- | --- | --- |
| `noul` | one number 0–1 | a yes/no. The number **is** the answer and the certainty; 0.5 means no idea. **No separate confidence field.** |
| `choice` | one option from a set you supply, plus probabilities over all of them | picking one. Cannot return an option you did not give it. |
| `score` | a number against an ordered rubric you write | ranking and thresholding. Good comparator, bad absolute reading. |

### The 3 asked once, about the driver

**`priority`** — Choice

> "What matters most to this driver, from what they said?"

```
speed          Wants to charge as fast as possible and get going again
safety         Wants somewhere well lit, busy, staffed or otherwise reassuring
cost           Wants the cheapest option, or has mentioned money
amenities      Wants food, a toilet, or somewhere to wait while it charges
reliability    Wants somewhere they can be confident will actually work
none_of_these  The driver expressed no particular preference
```

Returns `safety` at confidence **1.00** from *"I'd rather not stop somewhere sketchy"*.

`none_of_these` is mandatory. A Choice is forced to pick from what it is given, so without an escape
hatch it names a preference in a sentence that expressed none.

**`travelling_with_others`** — Noul

> "Is the driver travelling with other people?"

**0.97** from *"I've got my kid in the car"*.

**`wants_to_wait_somewhere`** — Noul

> "Does the driver want somewhere to wait, eat or take a break while the car charges?"

**0.46** on the example sentence. Genuinely ambiguous, and 0.46 is the honest answer rather than a
failure — worth saying, because a reader expecting a confident number will misread it.

### The 3 asked per charger — 8 chargers, so 24

**`time_limited_<id>`** — Noul. **The question that earns the project.**

> Do the notes for "Woolworths Fishermans Bend" say it is only usable at certain times of day, on
> certain days, or only while something else is open?

Note precisely what it asks: *do the notes describe a restriction* — **not** "is it open now". The
model never sees the clock. It reads prose and reports what the prose says. Code decides whether the
restriction bites.

Middy's Port Melbourne returns **0.99** on *"Only available during store trading hours. Trading
Hours Monday to Friday 6.00am - 5.00pm"*.

**`suits_<id>`** — Score, over this rubric:

```
0  The notes actively warn against it for this driver, or describe something
   they said they did not want
1  It would do, but there is a caveat in the notes this driver would mind
2  Nothing in the notes counts against it for this driver
3  The notes describe something this driver specifically asked for
```

Lands between levels — 1.34, 1.91. Compared against a threshold, never rounded to a label.

**`cost_<id>`** — Choice

> What do the cost notes for "Woolworths Fishermans Bend" amount to?

```
free · cheap · typical · expensive · conditional · not_stated
```

The article should dwell here. Raw data says `$0.45 per kWh`, `55c/kWh`, `Free`, `FREE`,
`AUD 0.42/kWh;other tariffs for older cars` — 347 distinct spellings across 926 sites. **The model is
never asked to turn that into a number.** That is parsing, which is generation, which is the one
thing it cannot do. It is asked which band, over a closed set. `$0.24/kWh` → `cheap`, which needs
real knowledge of Australian charging prices.

### The 1 at the end

**`best`** — Choice, options built from the shortlist:

```json
{
  "202146": "GET Electric Head Office",
  "202147": "Lorbek Luxury Cars",
  "210899": "Middy's Port Melbourne",
  "504658": "Laverton Supercharger",
  "none_of_these": "None of these suit what the driver described"
}
```

### Why a separate `best` at all — the load-bearing paragraph

The obvious design is: score all 8, sort by score. **It does not work.**

A Score is *absolute* — it means something against its own threshold and nothing against a different
question's Score, because the two were never measured on the same ruler. A Choice is *relative*: its
probabilities sum to 1, which makes them the only numbers in the API genuinely comparable to each
other.

So **8 Scores decide admissibility, 1 Choice decides order.**

The failure mode is counter-intuitive and the article should say so: sorting independent Scores does
not produce a jittery ranking, it produces a **frozen** one. Whichever option tends to score high
wins every time and the feature silently stops doing anything.

### The arithmetic

3 + 24 + 1 = **28**, in one request, 586ms, 4,140 input tokens, $0.00017.

They evaluate in parallel, so 28 costs roughly what 1 does in latency. **State size moves latency,
question count does not** — 20 chargers would be 64 questions, and the extra cost would come from the
extra prose, not the extra questions.

---

## Also worth explaining, by the same standard

Not asked directly, but adjacent to what was, and likely to trip a reader:

- **"no information" is not a pass.** An undocumented charger scores ~1.67 every time whatever you
  ask, because that is a calibrated answer to an unanswerable question. That sits above any sensible
  threshold, so code checks whether there was anything to judge *before* reading the score. See
  finding 4.
- **The empty top slot is normal.** Jev's favourite is often an undocumented site, the gate demotes
  it, and nothing is marked *recommended*. That is the gate working. See finding 7.
- **Distances are straight-line, not driving distance.** Every figure in the app is a lower bound.

---

## 5. How reliability is decided — asked directly, and the answer was "it isn't"

The author asked what actually determines that a charger is reliable when the driver says *"I've been
stranded by a broken charger before"*. At the time: nothing. The article should tell this story,
because it is the clearest example in the project of the real failure mode.

**What was broken.** `priority` was read off the answer at high confidence and then **dropped**. It
appeared twice in `plan.ts`, both times for display. The model understood the driver perfectly and
the code did nothing with it.

> A model answer that changes nothing about what the code does is not an input. It is decoration.

**What the fix was.** Not a better prompt. `DateLastVerified` is present on 100% of Australian
records and was sitting unread, and 75% of records have not been confirmed in over two years. Turning
a date into an age is arithmetic — code's job, and the model reads dates as text anyway.

**The asymmetry is the point.** Staleness only gates when the driver asked for reliability. The same
seven-year-old record is `warned` for a reliability-minded driver and `recommended` for a cost-minded
one. Same charger, same data, same Score. Only the stated priority differs — and that is what makes
reading the priority worth doing at all.

**The demonstration to use.** Same sentence, two cities, opposite outcomes:

```
"I've been stranded by a broken charger before. I need one that will definitely work."

Melbourne → Geelong    no recommendation — everything documented is 3-4 years unconfirmed
Sydney → Wollongong    Tesla Destination Charger — one year stale, and 1 actual driver report
```

**The pattern worth stating out loud.** This was the third defect in the project, and the third time
the fix was arithmetic code already had and was not using. Findings 6, 9 and 10. Not one was a prompt
problem. The instinct when a model-backed feature misbehaves is to rewrite the question; every time
here, the question was fine.

## 6. Why "best match" used to be rare

Worth explaining because a reader clicking around will notice it. Most results used to read *fine*
and nothing was ever *best match*.

Cause: `best.choice` is the single option the model rated highest, and it was frequently a charger
nobody had documented — which the evidence gate then demoted, leaving no recommendation at all.

The fix is a good illustration of using a Choice properly. A Choice returns **probabilities over
every option**, not just a winner, and those are the only genuinely comparable numbers in the API. So
the recommendation became the highest-probability option that *survives the gates*. The argmax was a
lossy shorthand for that all along.

Across 14 scenarios over 8 cities: **12 produced a best match, against 2 of 8 before.** The two that
did not are correct — Melbourne has nothing fresh enough for a reliability-minded driver, and every
Canberra charger in reach has no prose at all.

## 7. Start and end are now selectable

No longer hardcoded Melbourne → Geelong. Fourteen preset Australian locations, chosen to span very
different charger densities, because that is the variable that changes the behaviour: Melbourne CBD
returns 117 candidates, Traralgon returns 5. Both start and end are tagged on the map.

Presets rather than a geocoder, deliberately — Nominatim is the free option and asks for one request
per second plus a contact address, which is a second upstream service to degrade around for a demo
whose argument has nothing to do with geocoding. A fixed list also makes two runs comparable.

## 8. REQUESTED — explain the 138 → 8 filter and every decision in it

The author asked specifically that the article explain how the candidate list is narrowed and what
decisions are made along the way. It is the half of the system that is not the model, and it does
most of the work.

### The pipeline, in order

```
1,367 chargers in Australia
   ↓  bounding box over the journey corridor, ±0.3° (~33km)
  138 candidates fetched from Open Charge Map
   ↓  drop anything not operational
   ↓  drop anything out of reach on the charge you have
   ↓  sort by total added time, keep the best 8
    8 shortlisted  →  this is all the model ever sees
   ↓  28 questions in one request, prose only
    1 recommendation
```

### Every decision, and why

**Why a corridor box and not a radius around the start.** It *was* a 40km radius, and that silently
broke the battery entirely — see finding 13. A driver at 70% can reach 238km; a pool capped at 40km
cannot express that. The box spans both ends of the journey plus padding.

**Why "operational" defaults to false.** `StatusType.IsOperational` is absent on some records. An
unknown status is treated as *not* working. The opposite default would have the app recommending a
charger it knows nothing about, and the cost of that error falls entirely on the driver.

**Why the range is derated by 0.8.** `12% × 500km × 0.8 = 48km`. The 0.8 covers highway speed, a cold
battery, climate control. Deliberately pessimistic: arriving early is a mild annoyance, running flat
is a tow truck. The asymmetry of the two errors justifies the asymmetry of the estimate.

**Why a 15% reserve on top of that.** A charger must be within 85% of what the battery can currently
do, so the driver does not arrive on zero.

**Why the sort is total added time, not distance.** Detour alone ignores power, and ranked an 11kW
socket on the route above a 250kW one two minutes off it. Total time is `detour × 1.2 + charging
minutes`, where charging minutes is `shortfall km × 0.18 kWh/km ÷ kW`. It also has to agree with how
the results are then ordered — two different notions of "best" in one request is a bug waiting to be
noticed.

**Why a charger with unknown power sorts last, not first.** An unknown is not a zero. It appears at
the bottom of its band rather than the top.

**Why 8 and not all of them.** State size is what moves Jev's latency, not question count. Eight
chargers is ~4,100 input tokens and ~300–600ms; the whole corridor would be neither faster nor more
useful, because the reader is not going to read 138 cards.

**What is deliberately crude, and stated as such.** Straight-line distance throughout — Melbourne to
Geelong is 64.6km straight and 74.5km by road. No charge curve, so charging time understates a large
top-up. No AC/DC distinction beyond kW, so a 22kW AC figure may be limited by the car to 7kW. All of
it is fine for "enough to get there", which is the only question being asked.

### The line the article should land

Every number in that pipeline is exact, and **none of it goes to the model.** The model is handed
eight names and whatever people have written about them. It never sees a kilometre, a kilowatt or a
clock — because it cannot count, cannot calculate, and reads dates as text, and because code already
holds all three precisely.

Four times in this project a wrong-looking result turned out to be code failing to use a number it
already had (findings 6, 9, 10, 12). Not once was it a prompt problem. That is the most transferable
thing here: **when a model-backed feature misbehaves, check which half is actually failing before
rewriting the question.**

## 9. REQUESTED — the demo scenarios that must appear in the article

Verified against the shipped build on 27th September 2026, **run three consecutive times with
identical results**. Anything quoted here has reproduced; nothing below was measured against an
earlier build. Journey is Melbourne CBD → Geelong throughout, so only the sentence, the battery and
the clock ever change.

| | What do you need? | Battery | Arriving |
| --- | --- | ---: | --- |
| **A** | `I'm at 9% heading to Geelong with my kid asleep in the back. It's late and I don't want to stop anywhere dodgy.` | 9% | 21:30 |
| **B** | `On 12% heading to Geelong late morning. We need a toilet and somewhere to grab food while it charges.` | 12% | 11:00 |
| **C** | `Heading to Geelong, no rush at all. Just find me the cheapest place to plug in.` | 45% | 14:30 |
| **D** | `Early run to Geelong on 15%. I've been burnt by a dead charger before, I need one that definitely works.` | 15% | 06:30 |
| **E** | `Only 8% left and I need to be in Geelong. Absolute fastest charger, I cannot wait around.` | 8% | 17:45 |

### Results

```
A  SAFETY       9%  21:30  after dark    range 36km   shortlist 50–250kW, mean 139kW   picked by Jev
   → Ampol Foodary Altona North   180kW · 1.1km off route · ~2min · typical
     "4 bays – 2 x CCS2, 2 x CHAdeMO  All 180kW DC."

B  AMENITIES   12%  11:00  in daylight   range 48km   shortlist 50–250kW, mean 136kW   picked by Jev
   → Ampol Foodary Altona North   180kW · 1.1km off route · ~2min · typical

C  COST        45%  14:30  in daylight   range 180km  shortlist 11–250kW, mean 90kW    picked by Jev
   → Hobsons Bay Civic Centre      50kW · 0.2km off route · ~0min · FREE
     "Cannot be seen from the main road."

D  RELIABILITY 15%  06:30  after dark    range 60km   shortlist 7–250kW, mean 123kW    picked by CODE
   → Laverton Supercharger        250kW · 0.7km off route · ~0min
     "The best-evidenced option here — confirmed working in the last few months."

E  SPEED        8%  17:45  around dusk   range 32km   shortlist 50–250kW, mean 142kW   picked by CODE
   → Laverton Supercharger        250kW · 0.7km off route · ~1min
     "The quickest option overall — about 2 minutes including the detour, at 250kW."
```

### What each is for

- **A and E** — both low battery, and the shortlist is 50kW+ in both, mean 139 and 142kW. At 8–9% a
  slow charger would cost an hour, so the arithmetic excludes them before the model sees anything.
  Also shows the clock: `06:30` and `21:30` are both *after dark*, `17:45` is *around dusk*.
- **C** — 45% battery, 180km of range, and the shortlist mean drops to **90kW with 11kW chargers in
  it**. No fast charge needed, so cheap wins: a free council carpark.
- **D** — the only scenario whose winner is chosen on a **date**. Laverton is the only charger in
  reach confirmed working recently; everything else is 3+ years unverified.
- **C vs E** is the pair to lead with. Same journey, opposite answers, both checkable from the numbers
  on screen: free 50kW with a "can't be seen from the road" caveat, against a 250kW Supercharger.

### The honest caveat to include

**Three distinct winners across five priorities.** A and B both land on the Ampol Foodary; D and E
both land on Laverton. Those coincidences are real rather than a bug — a 180kW service station
genuinely is both the safest-feeling stop at 9:30pm *and* the one with food, and the fastest charger
here genuinely is also the best-evidenced one. Claiming five different answers would be dressing it up.

### The battery sweep, same sentence throughout

`Heading to Geelong, I need to charge somewhere on the way.`

| battery | usable range | mean kW of shortlist | slowest that qualifies |
| ---: | ---: | ---: | --- |
| 8% | 32km | **142 kW** | 50kW |
| 10% | 40km | 139 kW | 50kW |
| 15% | 60km | 124 kW | 7kW |
| 20% | 80km | **91 kW** | 11kW |
| 70% | 280km | 91 kW | 11kW |

**The lower the battery, the faster the chargers offered** — not the nearer ones. Nothing was told
about urgency; it falls out of dividing energy by power. It plateaus at 20% because past that the
64km journey needs no charge at all.

## 10. SUPERSEDED — see section 11. Kept because the reasoning is worth showing.

## 10. The interface now states which half decided

Added because the author asked to be able to see, on any result, what the request was read as and why
that charger won.

**The request banner**, above the answer, in its own colour per priority:

```
⚡ SPEED REQUEST
Read from your sentence as wanting the fastest charge. Looked at 138 chargers
and kept the 8 you can reach on 32km.
```

**The hero carries two badges**: `best for speed`, and `picked by code` or `picked by Jev`.

That second badge is the project's whole claim rendered on screen, and it is not decorative — it is
`Plan.decidedBy`, set by the same branch that actually chose the winner, so the interface cannot
misreport it. A test asserts it is non-null exactly when a recommendation exists.

Measured across the five scenarios:

| priority | decided by |
| --- | --- |
| safety | **Jev** |
| amenities | **Jev** |
| cost | **Jev** |
| reliability | **code** |
| speed | **code** |

> The model picks when the question is about language. Code picks when it is about quantity.

For the article this is the single most useful screenshot: five runs of the same journey, five
coloured banners, and the decider badge flipping between the two halves.

## 11. CORRECTION — nothing is decided by code, and section 9's results are superseded

The author's instruction: the article demonstrates Jev, so Jev must make every choice. Code deciding
anything makes it the wrong demo.

That was right, and it made the design better rather than worse — see finding 16. **Section 9's
results and section 10's code/model split are both superseded by this.** Use the table below.

### What changed

Code no longer picks anything. It filters, refuses, and — the part that was missing — **phrases every
quantity it holds as English before the model sees it**:

| number code holds | what Jev reads |
| --- | --- |
| `250 kW` | "very fast charging" |
| `11 kW` | "slow charging" |
| `0.7 km` detour | "barely off your route" |
| `27 min` | "about half an hour plugged in" |
| `2026-08-01` | "confirmed working in the last few months" |

The model still never sees a digit. The rule was never "don't tell it about quantities" — it is
**"never hand it a digit and expect arithmetic."**

### The results the article should use

Same five scenarios, same batteries and times as section 9. Jev chose every one.

```
A  SAFETY       9%  21:30  → Laverton Supercharger       250kW
B  AMENITIES   12%  11:00  → Ampol Foodary Altona North  180kW   a service station, for a food request
C  COST        45%  14:30  → Hobsons Bay Civic Centre     50kW   the free one
D  RELIABILITY 15%  06:30  → Laverton Supercharger       250kW   the recently-confirmed one
E  SPEED        8%  17:45  → Laverton Supercharger       250kW   chosen on "very fast charging"
```

**The sentence for the article:** before this change, code had to overrule the model to get a 250kW
charger recommended for a hurried driver. Now the model gets there unprompted — because it was finally
told which one was fast, in words it can read.

The hero card carries one badge now: **picked by Jev**. There is no other path.

### The honest cost, which the article should not skip

The evidence gate is gone as a veto, so an undocumented charger can win — and in scenario A it wins a
**safety** question on no safety information at all, because the derived bands describe speed and
distance, not whether a car park feels safe at night. The card says so:

> "Jev picked this from its specs — but nobody has written anything about the place itself."

And re-running the silence experiment shows finding 4's observation still holds: given identical
derived bands, a prose-free charger scores 1.749 across a 0.58 spread, while one with prose scores
1.461 across a 2.09 spread. **Absence of prose is still absence of a judgement** — we now disclose that
on the card rather than resolving it on the reader's behalf.

That trade is the interesting thing to write about, not something to hide: a gate that silently took
the model out of half the decisions was the wrong way to protect a demo about the model.

## 12. REQUESTED — the five examples in full, and how Jev actually picks

Verified 27th September 2026 against the shipped build, **winners stable across three consecutive
runs**. Journey is Melbourne CBD → Geelong in all five; only the sentence, battery and clock change.

### The inputs, verbatim

| | What do you need? | Battery | Arriving at |
| --- | --- | ---: | --- |
| **A** | `I'm at 9% heading to Geelong with my kid asleep in the back. It's late and I don't want to stop anywhere dodgy.` | 9 | 21:30 |
| **B** | `On 12% heading to Geelong late morning. We need a toilet and somewhere to grab food while it charges.` | 12 | 11:00 |
| **C** | `Heading to Geelong, no rush at all. Just find me the cheapest place to plug in.` | 45 | 14:30 |
| **D** | `Early run to Geelong on 15%. I've been burnt by a dead charger before, I need one that definitely works.` | 15 | 06:30 |
| **E** | `Only 8% left and I need to be in Geelong. Absolute fastest charger, I cannot wait around.` | 8 | 17:45 |

### The results

| | Read as | Daylight | Range | Winner | Jev's reason |
| --- | --- | --- | ---: | --- | --- |
| **A** | `safety` | after dark | 36km | Laverton Supercharger · 250kW | *"Jev picked this from its specs — but nobody has written anything about the place itself."* |
| **B** | `amenities` | in daylight | 48km | Ampol Foodary Altona North · 180kW | *"Nothing here suits what you asked for better."* |
| **C** | `cost` | in daylight | 180km | Hobsons Bay Civic Centre · 50kW · **free** | *"Free to use, and nothing here suits what you asked for better."* |
| **D** | `reliability` | after dark | 60km | Laverton Supercharger · 250kW | *"Jev picked this from its specs…"* |
| **E** | `speed` | around dusk | 32km | Laverton Supercharger · 250kW | *"Jev picked this from its specs…"* |

Every search: **~270–400ms, ~$0.00019.** Every winner picked by Jev.

### The two flips — stronger than the winners

Same charger, same data, opposite verdicts, because the sentence changed:

- **`Laverton Supercharger`** wins A, D and E. **Ruled out in B**: *"Jev judged it a poor fit for what
  you asked for."* A 250kW Supercharger is right for safety, reliability and speed, and wrong for a
  family wanting a toilet and lunch.
- **`Ampol Foodary Altona North`** wins B. **Ruled out in E**: *"Its own notes count against it."* A
  service station is right for food and wrong when you cannot wait around.

---

## 13. REQUESTED — how Jev picks, with the real request and response

All of this is captured output from scenario E, not illustrative.

### Step 1 — code narrows, then phrases its numbers as words

```ts
const src = await fetchChargers({ origin: MELBOURNE, destination: GEELONG, maxResults: 600 });
const picked = shortlist(src.chargers, {
  origin: MELBOURNE, destination: GEELONG, batteryPercent: 8, fullRangeKm: 500, max: 8,
});
// 138 candidates → 8, on operational status, reachability, and total added time.

const derived = derivedFactsFor(picked.shortlist, picked.legs, picked.rangeKm, Date.now());
// 250 kW      → "very fast charging"
// 0.7 km      → "barely off your route"
// ~1 min      → "you would barely have to stop"
// 2026-08-xx  → "confirmed working in the last few months"
```

### Step 2 — the state Jev receives. Note: no digits anywhere

```json
{
  "driver_said": "Only 8% left and I need to be in Geelong. Absolute fastest charger, I cannot wait around.",
  "arriving": "around dusk",
  "options": [
    {
      "id": 504658,
      "name": "Laverton Supercharger",
      "run_by": "Tesla (including non-tesla)",
      "charging": "very fast charging",
      "position_on_route": "barely off your route",
      "how_long": "you would barely have to stop",
      "last_confirmed": "confirmed working in the last few months",
      "access_note": null, "site_note": null, "cost_note": null,
      "driver_reports": [],
      "membership": "requires an account or app with the network"
    },
    {
      "id": 308750,
      "name": "Tesla Supercharger South Melbourne",
      "run_by": "Tesla (Tesla-only charging)",
      "charging": "very fast charging",
      "position_on_route": "barely off your route",
      "how_long": "you would barely have to stop",
      "last_confirmed": "not confirmed for over a year",
      "access_note": null, "site_note": null, "cost_note": null,
      "driver_reports": [],
      "membership": "requires an account or app with the network"
    }
  ]
}
```

### Step 3 — the question. Options are built from the shortlist

```json
{
  "type": "choice",
  "instructions": "Which option best suits what the driver asked for?",
  "criteria": {
    "210897": "Ampol Foodary Altona North",
    "210898": "Hobsons Bay Civic Centre",
    "267315": "Ampol Derrimut",
    "270949": "RMIT - City Campus",
    "270950": "JET Charge Office",
    "308228": "Toyota Altona",
    "308750": "Tesla Supercharger South Melbourne",
    "504658": "Laverton Supercharger",
    "none_of_these": "None of these suit what the driver described"
  }
}
```

### Step 4 — the answer. The probabilities are the interesting part

```
choice: "504658"   confidence: 0.970

probabilities                            suits score
  0.9700   250kW  Laverton Supercharger        2.56
  0.0200   180kW  Ampol Foodary Altona North   0.99
  0.0100         none_of_these
  0.0000   250kW  Tesla Supercharger Sth Melb  0.94   ← also 250kW
  0.0000   180kW  Ampol Derrimut               1.00
  0.0000    80kW  JET Charge Office            0.35
  0.0000    75kW  Toyota Altona                0.93
  0.0000    75kW  RMIT - City Campus           0.97
  0.0000    50kW  Hobsons Bay Civic Centre     0.56
```

### THE PARAGRAPH THE ARTICLE IS FOR

Look at the two 250kW Superchargers. Jev was handed **identical** words for both on every axis that
"fastest" turns on — `"very fast charging"`, `"barely off your route"`, `"you would barely have to
stop"`. It gave one **0.97** and the other **0.0000**.

The only two fields that differed:

| | Laverton | Tesla South Melbourne |
| --- | --- | --- |
| `run_by` | Tesla **(including non-tesla)** | Tesla **(Tesla-only charging)** |
| `last_confirmed` | confirmed in the last few months | not confirmed for over a year |

**It read "Tesla-only charging" and worked out that a driver who never said they had a Tesla probably
cannot use it.** No field in Open Charge Map says "this driver is ineligible". No `WHERE` clause
reaches it. Code would have shown both as equally good 250kW chargers 0.7km off the route — and it did,
until the model was given the words.

That is the whole argument in one probability distribution: **code found the eight, and Jev knew which
one the driver could actually plug into.**

### Step 5 — code applies the gates, and never picks

```ts
const plan = buildPlan(picked.shortlist, picked.legs, result.answers, {
  afterDark: arriving === "after dark",
  filteredByCode: picked.eliminated,
  rangeKm: picked.rangeKm,
  now,
});
```

`buildPlan` can only ever *refuse*:

1. **Time** — the notes describe a restriction and the driver arrives outside it → `ruled_out`.
2. **Score** — the suits Score is below threshold → `ruled_out`.
3. Everything surviving is ranked by the Choice's probabilities, highest first. That is the winner.

There is no branch where code chooses. `Plan.decidedBy` used to exist and was deleted, because the
answer became "always Jev".

## 14. CORRECTION (4 October 2026) - read before quoting section 13

Section 13's "paragraph the article is for" says Jev "read 'Tesla-only charging' and worked out that a
driver who never mentioned owning a Tesla probably cannot plug into it". A controlled test disproved
that as the main driver - see finding 18. Changing only `run_by` barely moved South Melbourne's score;
changing only `last_confirmed` lifted it past the pass mark. With every field equalised, list position
and the charger's name still shifted the split.

The revised article (`blog/2026/09/28/is-jev-just-hype-or-a-genuinely-different-kind-of-ai-v2.md`)
states the tested version. Its numbers come from `docs/captures/2026-10-04-five-scenarios.json` - 15
live calls, five scenarios x three runs, winners identical in all three. The candidate pool had grown
from 138 to 148 chargers since the 26 September measurements.
