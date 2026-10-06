import {
  displayKm,
  isReachable,
  legFor,
  minutesToReach,
  remainingRangeKm,
  type Leg,
} from "../geo/distance.ts";
import {
  costKey,
  suitsKey,
  timeLimitedKey,
  type DerivedFacts,
  NONE,
  SUITS_THRESHOLD,
  TIME_LIMITED_THRESHOLD,
  type CostBand,
  type Priority,
} from "../jev/questions.ts";
import { hasProse, type Charger, type Position } from "../ocm/charger.ts";
import {
  daysSince,
  freshnessFor,
  freshnessLabel,
  tooStaleForReliability,
  type Freshness,
} from "../verification/staleness.ts";

/**
 * The single seam. Answers come in here and never leave.
 *
 * Nothing downstream — no route handler, no React component — sees a raw Answer, a probability or a
 * confidence. They see a `PlannedStop` with a verdict and a reason. One pure function to test, and no
 * way for a threshold to end up duplicated in a component.
 *
 * ── Three gates, in order, and the order is the design ──────────────────────────────────────
 *
 * 1. **Time.** The notes describe a restriction and the driver arrives outside it.
 * 2. **Evidence.** Is there evidence RELEVANT to what the driver asked for? Finding 4.
 * 3. **Score.** Only now does the Score mean anything, because there was something to judge.
 *
 * ── Gate 2 asks about relevance, not about prose ─────────────────────────────────────────────
 *
 * It first asked simply "is there prose?", and for a driver who said *"fastest charger you have"* it
 * recommended an 11kW socket over a 250kW Supercharger — because the Supercharger had no notes. That
 * is the wrong question. Code holds 250kW exactly; the record is not missing evidence, it is missing
 * *prose*, and prose is not what "fastest" turns on.
 *
 *   - `speed` → a known power rating is the evidence, and code has it.
 *   - `reliability` → a recent verification date is the evidence, and code has it.
 *   - `cost`, `safety`, `amenities` → only prose can answer these, so the prose gate stands.
 *
 * ── Who picks the winner depends on the question ──────────────────────────────────────────────
 *
 * **The model picks when the question is about language. Code picks when it is about quantity.**
 *
 * For `speed` the winner is the admissible stop with the shortest charging time — arithmetic, and
 * asking a model to agree with a number we hold exactly buys nothing. For `reliability` it is the
 * freshest record. For everything else it is the highest-probability option the Choice returned,
 * because "does this feel safe" has no arithmetic behind it at all.
 *
 * Each gate is code deciding what a model answer *licenses*. The model reports what the prose says;
 * whether that disqualifies a charger for this driver at this hour is never its call.
 *
 * ── Why the recommendation uses probabilities, not the winner ────────────────────────────────
 *
 * `best.choice` is the single option the model rated highest, and it is frequently a charger nobody
 * has documented — which gate 2 then demotes, leaving nothing recommended at all (finding 7). The
 * fix is not to weaken the gate. It is to use the rest of the answer: a Choice returns probabilities
 * over *every* option, and those are the only numbers in this API that are genuinely comparable to
 * each other. So the recommendation is the highest-probability option that **survives the gates**,
 * which is what the argmax was a lossy shorthand for.
 */

export type Verdict = "recommended" | "acceptable" | "unknown" | "warned" | "ruled_out";

export interface PlannedStop {
  readonly charger: Charger;
  readonly leg: Leg;
  readonly verdict: Verdict;
  /** Plain English, for a human. Never a probability. */
  readonly reason: string;
  /** What the notes said, if anything. Shown so the reason can be checked against the source. */
  readonly evidence: string | null;
  readonly costBand: CostBand | null;
  /** True when the notes describe a time restriction and the driver arrives outside daylight. */
  readonly timeRisk: boolean;
  readonly detourKm: number;
  readonly maxPowerKw: number | null;
  /** Rough minutes plugged in to reach the destination. Null when the power is unknown. */
  readonly minutesToReach: number | null;
  /** How long since anyone confirmed this charger exists. Computed in code from a date. */
  readonly freshness: Freshness;
  /** That, in English. */
  readonly freshnessLabel: string;
  /** How many drivers have left a report. Zero is the common case and worth showing. */
  readonly driverReports: number;
  /**
   * The one stop the interface should shout about.
   *
   * Computed here rather than in a component so the list and the map cannot disagree about which
   * charger is the answer. It is the top-ranked stop that actually cleared every gate — the
   * recommendation when there is one, otherwise the best merely-acceptable option. When nothing
   * cleared the gates there is no hero, and an interface leading with nothing is the honest outcome.
   */
  readonly hero: boolean;
}

export interface Plan {
  readonly stops: readonly PlannedStop[];
  readonly priority: Priority | null;
  /** How many chargers code eliminated before the model was asked anything. */
  readonly filteredByCode: number;
  readonly shortlisted: number;
  readonly rangeKm: number;
}

export interface ShortlistOptions {
  readonly origin: Position;
  readonly destination: Position;
  readonly batteryPercent: number;
  readonly fullRangeKm: number;
  readonly max: number;
}

/**
 * Code's half, in full. No model, no judgement, no free text.
 *
 * Returns the shortlist and how many were eliminated, because "we asked about 8 of 231" is a fact the
 * interface should be able to state rather than imply.
 */
export function shortlist(
  chargers: readonly Charger[],
  options: ShortlistOptions,
): {
  readonly shortlist: readonly Charger[];
  readonly legs: ReadonlyMap<number, Leg>;
  readonly rangeKm: number;
  readonly eliminated: number;
} {
  const rangeKm = remainingRangeKm(options.batteryPercent, options.fullRangeKm);
  const legs = new Map<number, Leg>();

  /**
   * Total time this stop costs you: driving out of your way, plus sitting there.
   *
   * The shortlist used to sort on detour alone, which disagreed with how `buildPlan` then ordered the
   * results — that ranks on total time. Two different notions of "best" in one request is a bug
   * waiting to be noticed, and detour alone also ignores power, so an 11kW socket on the route beat a
   * 250kW one two minutes off it.
   *
   * A charger with unknown power sorts last rather than first: an unknown is not a zero.
   */
  const addedMinutes = (leg: Leg, charger: Charger): number => {
    const charging = minutesToReach(leg.toDestinationKm, rangeKm, charger.facts.maxPowerKw);
    if (charging === null) return Number.POSITIVE_INFINITY;
    return leg.detourKm * 1.2 + charging;
  };

  const survivors = chargers
    .map((charger) => {
      const leg = legFor(charger, options.origin, options.destination);
      legs.set(charger.id, leg);
      return { charger, leg };
    })
    .filter(({ charger }) => charger.facts.operational)
    .filter(({ leg }) => isReachable(leg, rangeKm))
    .sort((a, b) => {
      const byTime = addedMinutes(a.leg, a.charger) - addedMinutes(b.leg, b.charger);
      if (byTime !== 0) return byTime;
      // Tie-break on how soon you reach it. On a tight battery the nearer of two equal options is
      // the safer one, and this keeps the order stable rather than dependent on upstream ordering.
      return a.leg.fromOriginKm - b.leg.fromOriginKm;
    })
    .slice(0, options.max);

  return {
    shortlist: survivors.map((s) => s.charger),
    legs,
    rangeKm,
    eliminated: chargers.length - survivors.length,
  };
}

/**
 * The facts code worked out, ready to be phrased for the model.
 *
 * Built here rather than in the route so the words the model reads are derived from exactly the same
 * arithmetic the interface displays. Two separate derivations would eventually disagree, and the
 * disagreement would be invisible.
 */
export function derivedFactsFor(
  shortlisted: readonly Charger[],
  legs: ReadonlyMap<number, Leg>,
  rangeKm: number,
  now: number,
): Map<number, DerivedFacts> {
  const out = new Map<number, DerivedFacts>();
  for (const charger of shortlisted) {
    const leg = legs.get(charger.id) ?? { fromOriginKm: 0, toDestinationKm: 0, detourKm: 0 };
    const minutes = minutesToReach(leg.toDestinationKm, rangeKm, charger.facts.maxPowerKw);
    const freshness = freshnessFor(charger.facts.lastVerifiedAt, now);
    out.set(charger.id, {
      detourKm: leg.detourKm,
      minutesToReach: minutes === null ? null : Math.round(minutes),
      lastConfirmed: freshnessLabel(freshness, daysSince(charger.facts.lastVerifiedAt, now)),
    });
  }
  return out;
}

/** The shape we accept from the model. Deliberately loose: it is parsed, not trusted. */
interface RawAnswers {
  readonly [key: string]: {
    readonly score?: number;
    readonly noul?: number;
    readonly choice?: string;
    readonly confidence?: number;
    readonly probabilities?: Readonly<Record<string, number>>;
  };
}

/** Rank order for verdicts. Lower sorts first. */
const VERDICT_ORDER: Record<Verdict, number> = {
  recommended: 0,
  acceptable: 1,
  unknown: 2,
  warned: 3,
  ruled_out: 4,
};

function firstSentence(text: string, limit = 120): string {
  const trimmed = text.trim();
  const stop = trimmed.search(/[.!?](\s|$)/);
  const cut = stop > 0 && stop < limit ? trimmed.slice(0, stop + 1) : trimmed.slice(0, limit);
  return cut.length < trimmed.length ? `${cut.trim()}…` : cut.trim();
}

export interface PlanContext {
  readonly afterDark: boolean;
  readonly filteredByCode: number;
  readonly rangeKm: number;
  /** Injected rather than read from the clock, so a plan is a pure function of its inputs. */
  readonly now: number;
}

export function buildPlan(
  shortlisted: readonly Charger[],
  legs: ReadonlyMap<number, Leg>,
  answers: RawAnswers,
  context: PlanContext,
): Plan {
  const bestAnswer = answers["best"];
  const rawPriority = (answers["priority"]?.choice ?? null) as Priority | null;
  const priority = rawPriority === NONE ? null : rawPriority;

  // Only consulted when the driver actually asked for reliability. A staleness rule applied to
  // everyone would eliminate three quarters of the dataset, and for a driver who asked for the
  // cheapest option a five-year-old record is a risk they never said they minded. That asymmetry is
  // the entire reason for reading the priority — see finding 9, where it was read and then dropped.
  const reliabilityMatters = priority === "reliability";

  const stops: PlannedStop[] = shortlisted.map((charger) => {
    const leg = legs.get(charger.id) ?? { fromOriginKm: 0, toDestinationKm: 0, detourKm: 0 };
    const suits = answers[suitsKey(charger.id)]?.score ?? null;
    const timeLimited = answers[timeLimitedKey(charger.id)]?.noul ?? null;
    const costBand = (answers[costKey(charger.id)]?.choice ?? null) as CostBand | null;

    const evidence = charger.prose.access ?? charger.prose.general ?? charger.prose.cost;
    const restricted = timeLimited !== null && timeLimited >= TIME_LIMITED_THRESHOLD;
    const timeRisk = restricted && context.afterDark;

    const freshness = freshnessFor(charger.facts.lastVerifiedAt, context.now);
    const ageDays = daysSince(charger.facts.lastVerifiedAt, context.now);

    const base = {
      charger,
      leg,
      evidence: evidence === null ? null : firstSentence(evidence),
      costBand,
      timeRisk,
      detourKm: displayKm(leg.detourKm),
      maxPowerKw: charger.facts.maxPowerKw,
      minutesToReach: (() => {
        const minutes = minutesToReach(leg.toDestinationKm, context.rangeKm, charger.facts.maxPowerKw);
        return minutes === null ? null : Math.round(minutes);
      })(),
      freshness,
      freshnessLabel: freshnessLabel(freshness, ageDays),
      driverReports: charger.prose.userComments.length,
      // Overwritten once every verdict is known; a stop cannot know it is the hero on its own.
      hero: false,
    };

    // ── gate 1: a documented time restriction the driver would arrive outside ───────────────
    if (timeRisk) {
      return {
        ...base,
        verdict: "ruled_out" as const,
        reason: "Only open at certain times, and you would arrive outside them.",
      };
    }

    // ── gate 2: nothing written about it — a caveat now, not a refusal ─────────────────────
    //
    // This used to return `unknown` and block the charger from ever being recommended, because a
    // prose-free record gave the model nothing to judge and its Score was really "I don't know".
    //
    // That is no longer true. Code now phrases what it knows — "very fast charging", "barely off your
    // route", "confirmed working in the last few months" — so every option carries readable
    // information whether a human wrote about it or not. The model has something to go on, so it gets
    // to judge, and the absence of human notes becomes a caveat the card states plainly rather than a
    // veto applied on its behalf.
    const undocumented = !hasProse(charger);

    // ── gate 3: now the Score means something, because there was something to judge ────────
    if (suits === null) {
      return { ...base, verdict: "unknown" as const, reason: "No judgement came back." };
    }
    if (suits < SUITS_THRESHOLD) {
      return {
        ...base,
        verdict: "ruled_out" as const,
        reason: undocumented
          ? "Jev judged it a poor fit for what you asked for."
          : "Its own notes count against it, for what you asked for.",
      };
    }

    // ── gate 4: staleness, but only for a driver who asked to be sure it works ─────────────
    if (reliabilityMatters && tooStaleForReliability(freshness)) {
      return {
        ...base,
        verdict: "warned" as const,
        reason:
          charger.prose.userComments.length > 0
            ? `You asked for dependable, and this one is ${base.freshnessLabel}.`
            : `You asked for dependable, and nobody has confirmed this one in years.`,
      };
    }

    if (restricted) {
      return {
        ...base,
        verdict: "warned" as const,
        reason: "Limited hours. You should be fine arriving now, but worth checking.",
      };
    }

    return {
      ...base,
      verdict: "acceptable" as const,
      reason: undocumented
        ? "Nobody has written about this one, but Jev found nothing against it."
        : "Nothing in its notes counts against it.",
    };
  });

  // ── the recommendation ───────────────────────────────────────────────────────────────────
  //
  // Among the stops that cleared every gate, take the one the Choice rated highest. Probabilities
  // are used in preference to `choice` because the argmax is frequently an undocumented charger that
  // gate 2 removed, which used to leave nothing recommended at all.
  /**
   * What this stop costs you in total: driving out of your way, plus sitting there.
   *
   * Deliberately computed from the values the interface *displays*, so a reader can verify the
   * ordering from the numbers in front of them rather than taking it on trust.
   *
   * Used for the shortlist, for the recommendation under `speed`, and for ordering within a verdict
   * band — one notion of "best" in all three places. They disagreed once and it showed: ranking
   * `speed` on charging time alone recommended Ampcharge Werribee (180kW, 1.7km off route, 0 min
   * plugged in, 2.0 min total) over Laverton Supercharger (250kW, 0.7km off route, 1 min plugged in,
   * 1.8 min total). Werribee needs less charge only because it sits nearer the destination, so it
   * won on time-at-the-plug while losing on the journey. "Fastest" means fastest overall.
   */
  const cost = (stop: PlannedStop): number => {
    if (stop.minutesToReach === null) return Number.POSITIVE_INFINITY;
    return stop.leg.detourKm * 1.2 + stop.minutesToReach;
  };

  const admissible = stops.filter((stop) => stop.verdict === "acceptable");
  const probabilities = bestAnswer?.probabilities ?? null;
  let recommendedId: number | null = null;

  const FRESHNESS_RANK: Record<Freshness, number> = {
    fresh: 0,
    recent: 1,
    ageing: 2,
    stale: 3,
    abandoned: 4,
    unknown: 5,
  };

  /**
   * The winner is always the model's pick.
   *
   * For a while code chose it whenever the priority was measurable — fastest, most recently verified —
   * because asking a model to agree with a number we hold exactly buys nothing. The reasoning was
   * fine and the conclusion was wrong twice over. It took the model out of the decisions most worth
   * watching it make, and it was patching a problem that belonged one layer earlier: the model was
   * choosing badly because nobody had told it which charger was fast.
   *
   * Code now phrases every quantity it holds — "very fast charging", "barely off your route", "about
   * half an hour plugged in" — and the Choice decides on that. The model still never sees a digit and
   * is never asked to do arithmetic. It is asked which described option suits this driver, which is the
   * one thing it is for.
   *
   * Probabilities rather than the argmax, because `best.choice` is frequently a stop a gate removed.
   */
  if (admissible.length > 0) {
    if (probabilities !== null) {
      const ranked = [...admissible].sort(
        (a, b) => (probabilities[String(b.charger.id)] ?? 0) - (probabilities[String(a.charger.id)] ?? 0),
      );
      recommendedId = ranked[0]?.charger.id ?? null;
    } else if (bestAnswer?.choice !== undefined && bestAnswer.choice !== NONE) {
      recommendedId =
        admissible.find((stop) => String(stop.charger.id) === bestAnswer.choice)?.charger.id ?? null;
    }
  }

  /**
   * Why the winner won, in one sentence.
   *
   * "Best match for what you asked for" was the first attempt and it is worthless: the badge already
   * says best match, so the most prominent sentence on the page was carrying no information. This
   * names the concrete advantage where there is one, and the quoted note underneath carries the rest.
   */
  const recommendedReason = (stop: PlannedStop): string => {
    // The caveat has to survive promotion. A charger nobody has written about can now win, and if the
    // winning card is the one place that stops mentioning it, the gate might as well not exist.
    if (!hasProse(stop.charger)) {
      return "Jev picked this from its specs — but nobody has written anything about the place itself.";
    }
    const lead =
      stop.costBand === "free"
        ? "Free to use, and nothing"
        : stop.costBand === "cheap"
          ? "Priced below the usual, and nothing"
          : "Nothing";
    return `${lead} here suits what you asked for better.`;
  };

  const withRecommendation = stops.map((stop) =>
    stop.charger.id === recommendedId
      ? { ...stop, verdict: "recommended" as const, reason: recommendedReason(stop) }
      : stop,
  );

  // Verdict first, then total time cost. Deliberately NOT by suits score: a Score is absolute and
  // comparing two of them against each other is the unsound sort this project exists to avoid.
  // Ordering within a verdict band is arithmetic, which code has exactly — and it is total time, not
  // detour, because sorting on detour ranked an 11kW socket above a 250kW Supercharger for a driver
  // who needed 64km. A charger with unknown power sorts last: an unknown is not a zero.
  // Within the `unknown` band only, order by verification age before time.
  //
  // Finding 10: these are the chargers nobody has written about, so there is no prose to rank them
  // by — but there is still a date, and "confirmed working three months ago" is real evidence where
  // "last seen five years ago" is not. Applying this across every band would let a freshly-verified
  // charger outrank a judged one, which would put a code-side fact above a judgement about what the
  // driver actually asked for. Inside a band where no judgement was possible, it is the best signal
  // available.
  const FRESHNESS_ORDER: Record<Freshness, number> = {
    fresh: 0,
    recent: 1,
    ageing: 2,
    stale: 3,
    abandoned: 4,
    unknown: 5,
  };

  const sorted = [...withRecommendation].sort((a, b) => {
    const byVerdict = VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict];
    if (byVerdict !== 0) return byVerdict;
    if (a.verdict === "unknown") {
      const byFreshness = FRESHNESS_ORDER[a.freshness] - FRESHNESS_ORDER[b.freshness];
      if (byFreshness !== 0) return byFreshness;
    }
    const byCost = cost(a) - cost(b);
    return byCost !== 0 ? byCost : a.leg.detourKm - b.leg.detourKm;
  });

  // The first stop that cleared every gate. `sorted` already puts recommended before acceptable, so
  // this is a scan rather than another ranking decision.
  const heroId = sorted.find((s) => s.verdict === "recommended" || s.verdict === "acceptable")?.charger.id ?? null;

  return {
    stops: sorted.map((stop) => ({ ...stop, hero: stop.charger.id === heroId })),
    priority,
    filteredByCode: context.filteredByCode,
    shortlisted: shortlisted.length,
    rangeKm: context.rangeKm,
  };
}
