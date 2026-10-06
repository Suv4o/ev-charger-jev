# Findings

Numbered, measured, and kept even when they contradict something said earlier.

## 1. The split works on real data, first try

One journey — Melbourne to Geelong, 12% battery, arriving after dark — against 231 real chargers.

Code did the arithmetic: 48km of usable range after derating, 8 sites operational and reachable,
sorted by detour. Jev was asked 28 questions in one request about those 8, seeing no distance, no
kilowatt figure and no clock time.

```
priority                safety   (confidence 1.00)
travelling with others  0.97
591ms · 4,140 input tokens · $0.00017388
```

`safety` at confidence 1.00 from *"I'd rather not stop somewhere sketchy"*, and 0.97 on passengers
from *"I've got my kid in the car"*. Both correct.

## 2. THE ONE THAT MATTERS — code cleared a charger that was closed

`Middy's Port Melbourne`: operational, 25kW, 0.1km detour. Every structured field said yes.

```
AccessComments: "Only available during store trading hours.
                 Trading Hours Monday to Friday 6.00am - 5.00pm Saturday…"
```

Driver arrives after dark. `time_limited` came back **0.99** and code ruled it out.

There is no field in the Open Charge Map schema that carries this. No `WHERE` clause reaches it.
A driver sent there at 9pm finds a dead charger, and the database says everything is fine.

Two others in the same run, both caught on prose alone:

- `JET Charge Office` — *"Open to public for product testing, and may be taken offline at any time"* → suits 0.89, ruled out
- `Hobsons Bay Civic Centre` — *"Cannot be seen from the main road. Drive to the car park at the back of the council building"* → suits 1.34, ruled out for a driver who said "nothing sketchy", at night

## 3. Cost banding is correct, and it is not parsing

Five sites checked against their raw `UsageCost`:

| raw text | answered | correct |
| --- | --- | :---: |
| `$0.31/kWh` | cheap | yes |
| `$0.24/kWh` | cheap | yes |
| `null` | not_stated | yes |
| `null` | not_stated | yes |
| `null` | not_stated | yes |

Typical Australian public charging is around $0.45–0.60/kWh, so $0.24 and $0.31 genuinely are cheap.
That judgement needs world knowledge and a closed set of answers — and note what was **not** asked:
the model was never asked to turn `$0.31/kWh` into the number `0.31`. That is generation, it is the
one thing a System One model cannot do, and the arithmetic never needed to leave code.

## 4. THE IMPORTANT ONE — silence is not a judgement, and it looks like one

The probe's winner, `Woolworths Fishermans Bend`, had **no `AccessComments`, no `GeneralComments`
and no `UsageCost`**. It out-scored a 250kW Supercharger. Every low scorer had prose containing a
caveat. That looked like a bias toward sites nobody has written about.

Measured properly: 5 chargers with no prose against 5 with neutral prose, 3 driver scenarios,
same request each time.

| | mean suits | range | spread |
| --- | ---: | --- | ---: |
| no prose at all | **1.672** | 1.43 – 1.89 | 0.46 |
| has prose | **1.503** | 0.47 – 2.41 | **1.94** |

Silence does score higher on average. But the average is the least interesting number here:

> **Prose discriminates 4.2× more widely than silence does.** A charger with something written about
> it can score anywhere from 0.47 to 2.41. A charger with nothing written about it lands in a narrow
> band around 1.6 every single time, whatever the driver asked for.

Scenario 3 settles the interpretation. Asked for *"somewhere cheap while I get lunch"*, prose
**beat** silence — 1.82 against 1.65 — because the cost notes were relevant. Silence only wins when
the alternative's prose contains a caveat.

So this is not a model defect. A near-constant mid-score in the absence of evidence is what a
*calibrated* answer to an unanswerable question looks like. The model is saying "I have nothing to
go on", and saying it consistently.

**The defect is mine.** `SUITS_THRESHOLD` was 1.6, and the no-information score sits at ~1.67 — just
above it. So every charger nobody has written about was being silently admitted as judged-acceptable.

> A calibrated "I don't know" and a mild "yes" are the same number. Nothing in the answer tells them
> apart. Only the caller knows whether there was anything to judge, so only the caller can tell the
> difference — and it has to check.

**Fix:** code classifies on evidence *before* reading the score. A charger with no prose is
`unknown`, never `recommended`, and is ranked below anything actually judged. See `plan.ts`.

This is the same shape as the gate in the sibling project: the model answers the question it was
asked, and whether that answer is *licensed* is never its decision.

## 5. Cost and latency

| | |
| --- | --- |
| 28 questions, 8 chargers, one request | 591ms · 4,140 input tokens · $0.00017388 |
| 3 scenarios × 40 questions | $0.00061719 total |

Latency is roughly double the sibling project's 296ms median, and the reason is state size rather
than question count: 4,140 input tokens against ~2,600. Consistent with the vendor's own claim that
question count barely moves latency while state size does.


## 6. The fix worked, and immediately exposed a worse bug of mine

With the evidence gate in, `Woolworths Fishermans Bend` correctly dropped from recommended to
`unknown`. The next line of output was the problem:

```
acceptable    11kW    0km   GET Electric Head Office
acceptable    11kW    0km   Lorbek Luxury Cars
unknown      250kW  0.7km   Laverton Supercharger
```

An 11kW socket ranked above a 250kW Supercharger, for a driver at 12% who needed to cover 64km.

Nothing to do with the model. **Code had `PowerKW` exactly and was only using it as a filter, never
as a ranking term.** Ordering within a verdict band was by detour alone, so two minutes of extra
driving looked worse than an hour of extra sitting.

Fixed by computing time rather than distance: the shortfall in km, converted to kWh, divided by the
charger's power. Crude — no charge curve, no AC/DC distinction — and crude is fine for "enough to
get there", which is the only question being asked. A charger whose power is unknown sorts last
within its band rather than first, because **an unknown is not a zero.**

The general shape, which is the bit worth keeping:

> Every time the ranking looked wrong, the fix was arithmetic code already had and was not using —
> not a better prompt. It is worth checking which half is actually failing before reaching for the
> model.

Verdict still outranks time, and that is deliberate. A judged-acceptable 30-minute stop beats an
undocumented 2-minute one for a driver who said "nothing sketchy" and is arriving after dark.

## 7. Nothing gets recommended when the model's favourite is undocumented

Side effect of finding 4, visible in the same run: the `best` Choice named
`Woolworths Fishermans Bend`, the evidence gate demoted it to `unknown`, and so **no stop carries
the `recommended` verdict at all.**

That is correct behaviour rather than a bug — recommending a site nobody has written about is
exactly what the gate exists to prevent — but it means the interface cannot assume a recommendation
exists. An empty top slot is a normal outcome and has to read as one, not as a failure.

Left as it is. The honest answer to "which of these should I use?" is sometimes "none of them
confidently", and a demo that always produces a winner would be hiding the thing worth showing.

## 8. Latency moved with nothing but load

Same request, same 4,140 input tokens, three runs: **591ms, 685ms, 398ms.**

No code changed between the second and third. Anything quoted as a latency figure for this project
needs more than one sample behind it, and none of these are that yet.

## Not measured

- Whether `SUITS_THRESHOLD` is right. It was hand-set at 1.6, found to be wrong for the reason in
  finding 4, and the evidence gate now runs first. The threshold itself is still untuned.
- Repeatability. Every number above is one call per scenario. The sibling project found per-question
  movement of about ±0.03, which would matter for any charger sitting within that of a threshold.
- Anything involving a real route. All distances are straight-line; see `distance.ts`.

## 9. `reliability` is read and then dropped on the floor

Asked how the app decides a charger is reliable when the driver says *"I've been stranded by a
broken charger before, I need one that will definitely work"*. It does not. Three reasons, none of
them the model's fault.

**The priority answer is never used.** `priority` appears exactly twice in `plan.ts`: once being read
off the answer, once being put on the `Plan` for display. It affects no verdict, no gate and no
ordering. The model reads the driver's intent correctly, at high confidence, and the code then
ignores it. "Read as: reliability" in the UI is decoration.

**The two real reliability signals are unused or absent.**

| signal | state |
| --- | --- |
| `UserComments` — driver reports | sent to the model, but **0 of the 8 shortlisted chargers have any** |
| `IsRecentlyVerified` / `DateLastVerified` | captured into `ChargerFacts.recentlyVerified` and **never read by anything** |

Across the 231-charger fixture: 10 have driver reports, 14 are recently verified. Of the 8 in the
Melbourne shortlist, six are not recently verified and none has a single report.

The reports that do exist are exactly the right material, which makes the gap sharper:

```
"Pillars 1A, 1C, and 2C appear to be functional at this time. The others are probably not"
"Very slowly ramps up speed. Taken 5 mins to work up to 25kw output"
```

**So what won?** `Hobsons Bay Civic Centre` was marked best match for that driver on notes reading
*"Cannot be seen from the main road"* and *"30 minute parking zone"* — neither of which says anything
about whether it works. It won because it has prose, the prose contains no warning, and a Choice must
pick something.

> That is finding 4 wearing a different hat. "Nobody wrote that it is broken" is not "it works", and
> the system has no way to tell those apart.

**The mechanism is sound when evidence exists.** `JET Charge Office` — *"Open to public for product
testing, and may be taken offline at any time"* — was correctly ruled out for the same driver. The
model reads a reliability signal fine. There usually is not one.

**Fixes, in order of how much they say:**

1. **Use `recentlyVerified`.** Code holds it, and "last confirmed working three years ago" is
   arithmetic on a date. Third time in this project the fix has been arithmetic code already had and
   was not using — see also findings 6 and this one.
2. **Make `priority` load-bearing.** At minimum, `reliability` should demote unverified sites instead
   of ordering purely on charge time.
3. **Show "no reports" in the interface.** An undocumented charger and one with five good reports
   currently render identically.

Recorded rather than fixed immediately, because the pattern is the point: every ranking defect found
so far has been code failing to use a number it already had, and none has been a prompt problem.

## 10. Fixing finding 9 — and what it took

Three changes, and the interesting part is that only one of them touched a question.

### a. Verification age, computed in code

`DateLastVerified` is present on **100%** of the 1,367 Australian records, and the distribution is
the reason it matters:

| age | records |
| --- | ---: |
| 0–6 months | 112 |
| 6–12 months | 67 |
| 1–2 years | 164 |
| 2–5 years | **868** |
| over 5 years | 156 |

**1,024 of 1,367 — 75% — have not been confirmed in over two years.** Free signal that was being
thrown away. Turning a timestamp into an age is arithmetic, so it never leaves code; only the
resulting word does.

### b. The priority now gates, and only where the driver asked for it

`tooStaleForReliability` is consulted **only** when the priority reads `reliability`. Applied to
everyone it would eliminate three quarters of the dataset, and for a driver who asked for the
cheapest option a five-year-old record is a risk they never said they minded.

> That asymmetry is the whole reason for reading the priority. A model answer that changes nothing
> about what the code does is not an input, it is decoration.

Tested both directions: the same seven-year-old record is `warned` for a reliability-minded driver
and `recommended` for a cost-minded one. Same charger, same data, same Score — only the stated
priority differs.

### c. The recommendation uses probabilities, not the argmax

Finding 7 said nothing gets recommended when the model's favourite is undocumented. The fix was not
to weaken the evidence gate; it was to stop discarding most of the answer.

A Choice returns probabilities over **every** option, and those are the only genuinely comparable
numbers in the API. So the recommendation is now the highest-probability option that **survives the
gates** — which is what the argmax was a lossy shorthand for all along.

Measured across 14 scenarios spanning 8 cities: **12 produced a best match, against 2 of 8 before.**

The two that did not are both correct:

- **Melbourne + "I've been stranded before"** — every documented charger there is 3–4 years
  unconfirmed, so nothing qualifies. An empty top slot is the honest answer.
- **Canberra + safety** — all 8 shortlisted chargers have no prose whatsoever. Nothing to judge.

### The demonstration this bought

Same sentence, two cities, opposite outcomes:

```
"I've been stranded by a broken charger before. I need one that will definitely work."

Melbourne → Geelong    no recommendation. Everything documented is 3-4 years stale.
Sydney → Wollongong    Tesla Destination Charger, one year stale, 1 driver report.
```

The Sydney winner is the only charger in any run with an actual driver report on it.

## 11. Freshness and prose are independent, and the gate order shows it

Surfaced while checking finding 10. In the Melbourne reliability run, the **freshest record in the
whole shortlist** — `Laverton Supercharger`, confirmed within the last few months — sits in the
`unknown` band, because nobody has written a word about it.

For a driver asking specifically about reliability, a recent verification is *better* evidence than
any amount of prose. But it is evidence about a different question: prose answers "does this suit
you", a date answers "is this still there".

Partially addressed rather than solved. The `unknown` band now orders by verification age, so the
charger that is actually known to work recently leads the group instead of whichever happens to be
quickest to reach:

```
[unknown] Laverton Supercharger        fresh    250kW
[unknown] Collins Street               fresh      ?kW
[unknown] Woolworths Fishermans Bend   ageing    50kW
```

Deliberately **not** applied across verdict bands. Letting a freshly-verified undocumented charger
outrank a judged one would put a code-side fact above a judgement about what the driver actually
asked for, and the undocumented one still cannot be recommended. Two different questions, and the
honest answer to "does this suit you" for a charger nobody has described is still "no idea".

## 12. "Is there evidence?" was the wrong question

Running the five priorities side by side on one journey, `speed` recommended an **11kW socket over a
250kW Supercharger**. For a driver who said *"fastest charger you have, I'm in a hurry"*.

The Supercharger was `unknown`, because it has no notes, so it could not be recommended. Gate 2 asked
*"is there prose?"* — and that is the wrong question:

> Code holds 250kW exactly. That record is not missing evidence. It is missing **prose**, and prose is
> not what "fastest" turns on.

Gate 2 now asks whether there is evidence **relevant to what the driver asked for**:

| priority | what answers it | who holds it |
| --- | --- | --- |
| `speed` | a power rating | code |
| `reliability` | a recent verification date | code |
| `cost`, `safety`, `amenities` | the notes | only the prose |

A deliberately short list. Each entry claims a number code already holds settles the driver's stated
concern better than prose would, and that is only defensible where the concern is measurable. Adding
`safety` would be asserting that a kilowatt figure tells you whether a car park feels safe at night.

### And the same split decides who picks the winner

**The model picks when the question is about language. Code picks when it is about quantity.**

- `speed` → the admissible stop with the shortest charging time. Asking a model to agree with a number
  we hold exactly buys nothing, and a test proves code overrides the model here: given probabilities
  of 0.9 on an 11kW charger and 0.1 on a 250kW one, the 250kW wins.
- `reliability` → the freshest record, then most driver reports.
- everything else → the highest-probability admissible option from the Choice, because "does this feel
  safe" has no arithmetic behind it at all.

Result on the same journey, changing only the sentence:

```
SAFETY       Lorbek Luxury Cars        11kW   nothing in its notes counts against you
AMENITIES    Lorbek Luxury Cars        11kW   nothing in its notes counts against you
COST         Hobsons Bay Civic Centre  50kW   free to use
RELIABILITY  Collins Street             ?kW   confirmed working in the last few months
SPEED        Laverton Supercharger     250kW  a minute or so at 250kW
```

Before the fix, `speed` returned an 11kW charger and `reliability` returned nothing at all.

**Fourth time in this project the fix has been arithmetic code already had and was not using.**
Findings 6, 9, 10, 12. Not one has been a prompt problem.

## 13. The battery slider did nothing, and the reason was the search radius

Asked to demonstrate that a low battery shows nearer chargers. It did not — **10%, 30% and 70%
returned a byte-identical shortlist.**

Cause: the Open Charge Map query used a fixed **40km radius around the origin**. At 10% a driver can
reach 34km, at 70% they can reach 238km, and the candidate pool never extended past 40km either way.
The filter was working perfectly on a pool that could not express the difference.

Replaced with a bounding box over the whole corridor. Melbourne to Geelong: the radius found 117
chargers all clustered at the Melbourne end; the box finds **138**, including 16 near Geelong that
only become reachable once the battery allows it.

Also made the shortlist sort on **total added time** (detour driving + charging) rather than detour
alone. The two disagreed with how `buildPlan` then ordered results, and detour alone ignores power.

### What the battery actually changes — and it is better than "nearer"

| battery | usable range | mean kW of the shortlist | slowest that qualifies |
| ---: | ---: | ---: | --- |
| 8% | 32km | **142 kW** | 50kW |
| 10% | 40km | 139 kW | 50kW |
| 12% | 48km | 136 kW | 50kW |
| 15% | 60km | 124 kW | 7kW |
| 18% | 72km | 118 kW | 7kW |
| 20% | 80km | **91 kW** | 11kW |
| 25%+ | 100km+ | 91 kW | 11kW (stable) |

> **The lower the battery, the faster the chargers offered.** Not the nearer ones — the faster ones.

Because at 10% you need a large charge, so charging time dominates and an 11kW socket would cost an
hour. By 20% the remaining 64km needs almost nothing, charging time collapses toward zero for
everything, and a slow charger two minutes away becomes the sensible answer.

It plateaus at 20% because beyond that the journey needs no charge at all. Nothing in the app was
told about urgency; it falls out of dividing energy by power.

## 14. "Fastest" is not "least time at the plug"

Reported by the author against a shipped build: asking for the fastest charger returned
`Ampcharge Werribee` rather than `Laverton Supercharger`. The numbers:

| | kW | detour | charging | **total** |
| --- | ---: | ---: | ---: | ---: |
| Laverton Supercharger | 250 | 0.7km | 1 min | **1.8 min** |
| Ampcharge Werribee | 180 | 1.7km | 0 min | **2.0 min** |

Werribee needs *no* charge at all — not because it is faster, but because it sits nearer Geelong, so
the shortfall it has to cover is smaller. Ranking `speed` on charging time alone made that look like
a win while it cost the driver more overall.

`cost()` is now computed once and used in all three places that order things: the shortlist, the
`speed` recommendation, and ordering within a verdict band. They disagreed, and this is what that
looks like from the outside.

Deliberately computed from the values the interface **displays**, so a reader can check the ordering
against the numbers in front of them instead of trusting it.

### Two process notes, because both cost the author time

**The numbers reported for the five priorities were stale.** They were measured after the
relevance-gate fix but before the corridor search, and not re-run. Changing the candidate pool from
117 to 138 chargers changes every answer. A result measured against a build that no longer exists is
worse than no result, because it reads as verified.

**`cost()` being defined after the code that needed it was the whole bug.** The recommendation block
ran above it, so it reached for `minutesToReach` instead — the nearest thing in scope. Ordering in
the file made the wrong thing easy.

## 15. A charger sitting on the threshold makes a scenario unreproducible

Building a set of demo scenarios, one came back with **no winner at all** and then produced one on a
later run with nothing changed. The cause, from dumping the raw Scores:

```
"We need a toilet and somewhere to grab food while it charges."   threshold 1.60

  2.00 PASS  Woolworths Fishermans Bend     (no prose)
  1.90 PASS  Middy's Port Melbourne         "Only available during store trading hours…"
  1.61 PASS  Lorbek Luxury Cars             "$0.31/kWh"        ← 0.01 clear
  1.51 fail  GET Electric Head Office       "$0.24/kWh"
  1.10 fail  Hobsons Bay Civic Centre       "Cannot be seen from the main road…"
  0.73 fail  JET Charge Office              "Open to public for product testing…"
```

`Lorbek` clears the threshold by **0.01**. Per-question movement across identical repeats is about
±0.03, so whether that scenario has a recommendation is decided by noise.

This is the sibling project's finding 8 reproducing exactly, on different data and a different
question:

> Whether a result is stable is not a property of the model. It is a property of how close a threshold
> sits to where the answers actually land.

The scores themselves are discriminating well — the cost run is unarguable, with `$0.24/kWh` at 2.00
and free at 2.12 against "may be taken offline at any time" at 0.83. The instability is entirely
about one charger's distance from a line I drew by hand.

**Not fixed by moving the threshold**, which would just relocate the problem. The scenario was
changed instead: at 12% battery rather than 25%, the shortlist contains a service station whose notes
actually bear on food, and it wins by a clear margin. Three consecutive runs then returned identical
winners across all five scenarios.

The honest statement for the article: a demo scenario needs its margin checked, not just its answer.
A scenario that happens to work is not the same as one that reproduces.

## 16. Nothing is chosen by code any more — and the fix was one layer earlier

Findings 9, 10 and 12 built up a design where code chose the winner whenever the driver's priority was
measurable: `speed` ranked on charging time, `reliability` on verification age. The reasoning was that
asking a model to agree with a number we hold exactly buys nothing.

The reasoning was sound. **The conclusion was wrong twice over.**

It took the model out of exactly the decisions a reader most wants to watch it make — and it was
patching a problem that belonged a layer earlier. Jev was choosing badly for `speed` because **nobody
had told it which charger was fast.**

### The rule, restated

The rule was never "never tell the model about quantities". It is:

> **Never hand the model a digit and expect arithmetic.**

Code can do the arithmetic and hand over the *conclusion in English*. Then the judgement is the
model's again, with nothing approximate about the inputs. That is the pattern the sibling project
already used for ship telemetry, and it was not being applied here.

So code now phrases everything it holds, with thresholds that are exact and applied before the model
sees anything:

| number code holds | what the model reads |
| --- | --- |
| `250 kW` | "very fast charging" |
| `11 kW` | "slow charging" |
| `0.7 km` detour | "barely off your route" |
| `27 min` charging | "about half an hour plugged in" |
| `2026-08-01` | "confirmed working in the last few months" |

The model still never sees a digit. `codeAnswersFor`, the `speed`/`reliability` ranking branches and
`Plan.decidedBy` are all gone. There is exactly one path to a recommendation: the Choice's
probabilities over whatever survived the gates.

### It works, unprompted

Same five scenarios, Jev choosing every time with no code intervention:

```
SAFETY       Laverton Supercharger       250kW
AMENITIES    Ampol Foodary Altona North  180kW   ← a service station, for a food request
COST         Hobsons Bay Civic Centre     50kW   ← the free one
RELIABILITY  Laverton Supercharger       250kW   ← the recently-confirmed one
SPEED        Laverton Supercharger       250kW   ← 250kW, chosen on "very fast charging"
```

`SPEED` picking the 250kW Supercharger is the whole point: before, code had to overrule the model to
get that answer. Now the model gets there on its own, because it was finally told.

### What this costs, stated plainly

The evidence gate from finding 4 is gone as a *veto*. An undocumented charger can now be recommended,
and scenario A does exactly that — `Laverton Supercharger` wins a **safety** request on no safety
information whatsoever, because the derived bands describe speed and distance, not whether a car park
feels safe at night.

The mitigation is a caveat that survives promotion, tested:

> "Jev picked this from its specs — but nobody has written anything about the place itself."

And re-running the silence experiment shows finding 4's underlying observation **is still true**:

| | mean suits | range | spread |
| --- | ---: | --- | ---: |
| no prose at all | **1.749** | 1.33 – 1.91 | 0.58 |
| has prose | **1.461** | 0.43 – 2.52 | **2.09** |

Given identical derived bands, a charger with no prose still scores in a narrow band whatever is
asked, while one with prose scores across a range three and a half times wider. Absence of prose is
still absence of a judgement.

So this is a deliberate trade rather than a refutation: the demo exists to show what Jev decides, and
a gate that silently removed the model from half the decisions was the wrong way to protect it. The
risk is disclosed on the card instead of being resolved on the reader's behalf.

## 17. THE ONE FOR THE ARTICLE — two identical Superchargers, 0.97 against 0.0000

Captured while dumping the real request and response for the `speed` scenario. Jev was handed eight
chargers, of which two were 250kW Tesla Superchargers, and the words describing them were **identical
on every axis "fastest" turns on**:

```
charging:            "very fast charging"        ← same
position_on_route:   "barely off your route"     ← same
how_long:            "you would barely have to stop"  ← same
```

The probabilities:

```
0.9700   Laverton Supercharger                suits 2.56
0.0000   Tesla Supercharger South Melbourne   suits 0.94
```

Two fields differed:

| | Laverton | Tesla South Melbourne |
| --- | --- | --- |
| `run_by` | Tesla **(including non-tesla)** | Tesla **(Tesla-only charging)** |
| `last_confirmed` | confirmed in the last few months | not confirmed for over a year |

> **It read "Tesla-only charging" and worked out that a driver who never said they owned a Tesla
> probably cannot plug into it.**

Nothing in the Open Charge Map schema says "this driver is ineligible". The eligibility lives in an
operator's *name*. No `WHERE` clause reaches it, and code did in fact rank both as equally good 250kW
chargers 0.7km off the route — right up until the model was handed the words.

That is the project's whole argument in one probability distribution: **code found the eight, and Jev
knew which one the driver could actually use.** More convincing than any accuracy percentage, because
there is no percentage to argue with — just two rows that should have tied and did not.

Worth noting what made it visible: the distribution, not the answer. `best.choice` alone would have
said `504658` and told you nothing about why the other Supercharger lost. The argmax is a lossy
summary of a Choice; the probabilities are the result.

## 18. CORRECTION to finding 17 - it was the confirmation date, not "Tesla-only"

Finding 17 said Jev "read 'Tesla-only charging' and worked out that a driver who never mentioned
owning a Tesla probably cannot plug into it". That was never isolated: the two Superchargers differ in
**two** fields, `run_by` and `last_confirmed`. Tested on 4 October 2026 by re-sending the exact
captured scenario E state with one field changed at a time on Tesla South Melbourne, three runs each:

| change to South Melbourne | its suits score | its `best` probability | Laverton's |
| --- | ---: | ---: | ---: |
| none (as captured) | 0.90 - 0.93 | 0.00 | 0.97 - 0.98 |
| `run_by` -> "Tesla (including non-tesla)" | 1.03 - 1.04 | 0.00 | 0.96 - 0.98 |
| `last_confirmed` -> "confirmed working in the last few months" | **1.61 - 1.70** | 0.02 - 0.03 | 0.92 - 0.94 |
| both | 2.15 - 2.19 | 0.18 - 0.23 | 0.67 - 0.71 |

> "Tesla-only" on its own barely moves anything. The confirmation date does most of the work - it
> alone lifts South Melbourne's score past the 1.6 pass mark.

### And with every field identical, the name and the list position still matter

| variant (both fields equalised) | Laverton (id 504658) | South Melbourne (id 308750) |
| --- | ---: | ---: |
| original order, Laverton listed first | 0.69 - 0.75 | 0.16 - 0.19 |
| South Melbourne moved to the top of the list | 0.43 - 0.53 | 0.39 - 0.49 |
| names swapped between the two ids | 0.25 - 0.26 (now named South Melbourne) | 0.65 - 0.67 (now named Laverton) |

Two genuine biases, both worth knowing for anyone building on Choice:

- **Position.** Moving an option to the top of an otherwise-tied list shifts the split from ~70/20 to
  roughly even.
- **Name.** Whichever option is *called* "Laverton Supercharger" wins, even from second place.
  Plausibly geography - Laverton sits on the freeway towards Geelong - but that is a guess; the test
  shows the name matters, not why.

The article now states the tested version, and lists the position/name effect as a limitation. The
superseded v1 article still carries the old claim and should not be quoted.
