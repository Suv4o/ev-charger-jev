import { choice, noul, score } from "@typesafe-ai/sdk";
import type { EntryType, Question, Questions } from "@typesafe-ai/sdk";

import type { Charger } from "../ocm/charger.ts";

/**
 * What we ask Jev, and — more importantly — what we refuse to ask it.
 *
 * ── The shape, which is the load-bearing decision ───────────────────────────────────────────
 *
 * Per-charger **Scores decide admissibility only**, each compared against its own threshold. One
 * **Choice over the shortlist decides order.**
 *
 * The tempting alternative is to score every charger and sort by the score. It is unsound. A Score
 * is absolute: it means something against its own threshold and nothing at all against another
 * question's Score, because the two were never measured on the same ruler. A Choice is relative —
 * its probabilities sum to one, which makes them the only numbers in this API that are genuinely
 * comparable to each other.
 *
 * The failure mode of getting this wrong is worth stating because it is counter-intuitive: sorting
 * independent Scores does not produce a jittery ranking, it produces a **frozen** one. Whichever
 * charger tends to score high wins every time, and the feature quietly stops doing anything.
 *
 * ── What never reaches the model ────────────────────────────────────────────────────────────
 *
 * No distance, no kilowatt figure, no stall count, no price as a number, no clock time. Those are
 * arithmetic, code has them exactly, and the vendor documents that the model cannot count, cannot
 * calculate and reads dates as text.
 *
 * One deliberate exception: the driver's own sentence is passed through verbatim, digits and all.
 * "I'm at 12%" is the driver's words, not a quantity we derived and expect to be reasoned over. The
 * rule is about not outsourcing our own arithmetic, not about scrubbing the input.
 *
 * ── What we refuse to ask ───────────────────────────────────────────────────────────────────
 *
 * Not "what does this cost per kWh?" — that is parsing free text into a number, which is generation,
 * which is the one thing a System One model cannot do. We ask which band it falls in, over a closed
 * set, and the arithmetic stays in code.
 */

/** Below this, a charger is not offered. Hand-tuned; see docs/thresholds.md. */
export const SUITS_THRESHOLD = 1.6;

/** Above this, the time-restriction warning is shown. A Noul: the number IS the answer. */
export const TIME_LIMITED_THRESHOLD = 0.6;

/** Escape hatch. A Choice is forced to pick from what it is given, so every Choice needs one. */
export const NONE = "none_of_these";

export const PRIORITIES = {
  speed: "Wants to charge as fast as possible and get going again",
  safety: "Wants somewhere well lit, busy, staffed or otherwise reassuring",
  cost: "Wants the cheapest option, or has mentioned money",
  amenities: "Wants food, a toilet, or somewhere to wait while it charges",
  reliability: "Wants somewhere they can be confident will actually work",
  [NONE]: "The driver expressed no particular preference",
} as const;

export type Priority = keyof typeof PRIORITIES;

export const COST_BANDS = {
  free: "The notes say charging here is free",
  cheap: "Priced, and noticeably below what public charging usually costs",
  typical: "Priced at about what public charging usually costs",
  expensive: "Priced above what public charging usually costs, or carries extra fees",
  conditional: "The price depends on time of day, membership, or something else the driver must check",
  not_stated: "The notes do not say what it costs",
} as const;

export type CostBand = keyof typeof COST_BANDS;

/**
 * Ordered rubric for whether a site suits this driver.
 *
 * Four levels, and read as a **comparator, not a magnitude**. Measured Scores land squashed into
 * the upper middle of their range, so rounding this to pick a label would put a merely-adequate
 * site in the top bucket. It is compared against SUITS_THRESHOLD and otherwise only ranked.
 */
export const SUITS_RUBRIC = [
  "The notes actively warn against it for this driver, or describe something they said they did not want",
  "It would do, but there is a caveat in the notes this driver would mind",
  "Nothing in the notes counts against it for this driver",
  "The notes describe something this driver specifically asked for",
] as const;

/** Per-charger question keys. Author-controlled identifiers; charger text never becomes a key. */
export const suitsKey = (id: number): string => `suits_${id}`;
export const timeLimitedKey = (id: number): string => `time_limited_${id}`;
export const costKey = (id: number): string => `cost_${id}`;

/** How the driver's arrival lands, as a word. Code owns the clock; the model reads English. */
export type Daylight = "in daylight" | "around dusk" | "after dark";

/**
 * Minutes since midnight, not an hour.
 *
 * It used to take a bare hour, which made the interface ask for "Arriving: 21" — a number a reader
 * has to decode. The input is now a real time field, so the boundaries are expressed in minutes and
 * 17:45 lands where it should instead of being rounded to 17:00.
 *
 * Deliberately still coarse in what it *returns*: three words, because the model reads English and
 * cannot compare times. Code keeps the precision; the model gets the conclusion.
 */
export function daylightFor(minutesSinceMidnight: number): Daylight {
  const m = ((Math.round(minutesSinceMidnight) % 1440) + 1440) % 1440;
  if (m >= 7 * 60 && m < 17 * 60) return "in daylight";
  if (m >= 17 * 60 && m < 19 * 60) return "around dusk";
  return "after dark";
}

/** "21:30" → 1290. Returns null on anything that is not a time. */
export function parseTimeOfDay(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Caps, so one pathological record cannot push the state past anything reasonable. */
const MAX_FIELD_CHARS = 600;
const MAX_COMMENTS = 3;

function clip(value: string | null): string | null {
  if (value === null) return null;
  // Strip control and format characters before measuring. A record carrying them would otherwise
  // survive into the state as invisible bytes.
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (clean === "") return null;
  return [...clean].length <= MAX_FIELD_CHARS
    ? clean
    : `${[...clean].slice(0, MAX_FIELD_CHARS).join("")}…`;
}

/**
 * One charger as the model sees it. Note the absence of every number.
 *
 * A `type` rather than an `interface` on purpose: only a type alias gets TypeScript's implicit index
 * signature, which is what lets this satisfy the SDK's JSON-shaped `EntryType` without a cast. An
 * `interface` here compiles everywhere except the one line that matters.
 */
/**
 * Code's numbers, converted to words the model can read.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────
 *
 * For a while code picked the winner whenever the driver's priority was measurable — fastest charger,
 * most recently verified — on the grounds that asking a model to agree with a number we hold exactly
 * buys nothing. That reasoning is sound and the conclusion was still wrong, because it took the model
 * out of exactly the decisions a reader most wants to watch it make.
 *
 * The rule was never "never tell the model about quantities". It is **"never hand the model a digit
 * and expect arithmetic"**. Code can do the arithmetic and hand over the *conclusion* in English, and
 * the judgement is the model's again with nothing approximate about the inputs.
 *
 * So `4.2km` becomes "barely off your route", and `27 minutes at 11kW` becomes "about half an hour
 * plugged in". Every threshold below is code's, exact, and applied before the model sees anything.
 */

export type SpeedBand = "very fast charging" | "fast charging" | "moderate charging" | "slow charging";

export function speedBand(kw: number | null): SpeedBand | null {
  if (kw === null) return null;
  if (kw >= 150) return "very fast charging";
  if (kw >= 50) return "fast charging";
  if (kw >= 22) return "moderate charging";
  return "slow charging";
}

export type DetourBand =
  | "right on your route"
  | "barely off your route"
  | "a short detour"
  | "a real detour";

export function detourBand(km: number): DetourBand {
  if (km < 0.5) return "right on your route";
  if (km < 2) return "barely off your route";
  if (km < 8) return "a short detour";
  return "a real detour";
}

export type WaitBand =
  | "you would barely have to stop"
  | "a few minutes plugged in"
  | "about half an hour plugged in"
  | "well over an hour plugged in";

export function waitBand(minutes: number | null): WaitBand | null {
  if (minutes === null) return null;
  if (minutes <= 2) return "you would barely have to stop";
  if (minutes <= 15) return "a few minutes plugged in";
  if (minutes <= 45) return "about half an hour plugged in";
  return "well over an hour plugged in";
}

/** Everything code worked out about one charger, ready to be phrased. */
export interface DerivedFacts {
  readonly detourKm: number;
  readonly minutesToReach: number | null;
  readonly lastConfirmed: string;
}

export type ChargerView = {
  readonly id: number;
  readonly name: string;
  readonly run_by: string | null;
  /** Derived from kW in code. A word, never a number. */
  readonly charging: SpeedBand | "charging speed not known";
  /** Derived from the detour in code. */
  readonly position_on_route: DetourBand;
  /** Derived from energy needed divided by power, in code. */
  readonly how_long: WaitBand | "how long is not known";
  /** How long since anyone confirmed it exists. A phrase, computed from a date in code. */
  readonly last_confirmed: string;
  readonly access_note: string | null;
  readonly site_note: string | null;
  readonly cost_note: string | null;
  readonly driver_reports: string[];
  readonly membership: string;
};

export function toChargerView(charger: Charger, derived: DerivedFacts): ChargerView {
  return {
    id: charger.id,
    name: charger.name,
    run_by: charger.facts.operator,
    charging: speedBand(charger.facts.maxPowerKw) ?? "charging speed not known",
    position_on_route: detourBand(derived.detourKm),
    how_long: waitBand(derived.minutesToReach) ?? "how long is not known",
    last_confirmed: derived.lastConfirmed,
    access_note: clip(charger.prose.access),
    site_note: clip(charger.prose.general),
    cost_note: clip(charger.prose.cost),
    driver_reports: charger.prose.userComments
      .slice(0, MAX_COMMENTS)
      .map(clip)
      .filter((c): c is string => c !== null),
    // A boolean rendered as a phrase, because the model reads English, not flags.
    membership: charger.facts.membershipRequired
      ? "requires an account or app with the network"
      : "open to anyone",
  };
}

/**
 * The state as the model receives it.
 *
 * Exported for documentation and tests. `buildState` declares `EntryType` as its return type rather
 * than this, because the SDK requires a mutable JSON-shaped value and a `readonly` array is not
 * assignable to one. Keeping the precise type here and widening at the boundary is the honest
 * version of that: the shape is still written down, it just is not what crosses the wire type.
 */
export interface EvaluationState {
  readonly driver_said: string;
  readonly arriving: Daylight;
  readonly options: readonly ChargerView[];
}

export function buildState(
  driverSaid: string,
  shortlist: readonly Charger[],
  arriving: Daylight,
  derived: ReadonlyMap<number, DerivedFacts>,
): EntryType {
  return {
    // Passed through verbatim, then capped. This is the one field an untrusted party controls, and
    // it is treated as a layer rather than a boundary: every gate that matters is in code.
    driver_said: clip(driverSaid) ?? "(the driver said nothing)",
    arriving,
    options: shortlist.map((charger) =>
      toChargerView(
        charger,
        derived.get(charger.id) ?? { detourKm: 0, minutesToReach: null, lastConfirmed: "not known" },
      ),
    ),
  };
}

/**
 * Every question in one request.
 *
 * Fan-out is the documented default: questions evaluate in parallel, so asking thirty costs roughly
 * what asking one does in time. State size moves latency; question count does not.
 */
export function buildQuestions(shortlist: readonly Charger[]): Questions {
  const questions: Record<string, Question> = {
    priority: choice("What matters most to this driver, from what they said?", PRIORITIES),
    travelling_with_others: noul("Is the driver travelling with other people?"),
    wants_to_wait_somewhere: noul(
      "Does the driver want somewhere to wait, eat or take a break while the car charges?",
    ),
  };

  for (const charger of shortlist) {
    questions[timeLimitedKey(charger.id)] = noul(
      `Do the notes for "${charger.name}" say it is only usable at certain times of day, ` +
        `on certain days, or only while something else is open?`,
    );
    questions[suitsKey(charger.id)] = score(
      `Given what the driver said, how well does "${charger.name}" suit them?`,
      SUITS_RUBRIC,
    );
    questions[costKey(charger.id)] = choice(
      `What do the cost notes for "${charger.name}" amount to?`,
      COST_BANDS,
    );
  }

  // The ordering question. Its probabilities are the only comparable numbers in the response, so
  // this — not the Scores above — is what decides which charger is shown first.
  const options: Record<string, string> = {};
  for (const charger of shortlist) {
    options[String(charger.id)] = charger.name;
  }
  options[NONE] = "None of these suit what the driver described";

  questions["best"] = choice("Which option best suits what the driver asked for?", options);

  return questions;
}
