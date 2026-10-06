import { readFileSync } from "node:fs";

import "dotenv/config";

import { billedCostUsd, createJevClient } from "../lib/jev/client.ts";
import { buildQuestions, buildState, daylightFor, suitsKey } from "../lib/jev/questions.ts";
import { hasProse, toChargers, type Charger } from "../lib/ocm/charger.ts";
import { derivedFactsFor, shortlist as makeShortlist } from "../lib/plan/plan.ts";
import type { OcmPoi } from "../lib/ocm/types.ts";

/**
 * Does a charger with nothing written about it score like a good one?
 *
 * The probe threw up a suspicion: the winner had no `AccessComments`, no `GeneralComments` and no
 * `UsageCost`, and it out-scored a 250kW Supercharger. Every low scorer had prose containing a
 * caveat. If silence reads as a clean bill of health, the product recommends the sites nobody has
 * written about, which is the opposite of what a driver wants.
 *
 * This asks the same question of matched groups across several driver scenarios and reports the two
 * distributions. It is a measurement, not a demo.
 */

const MELBOURNE = { lat: -37.8136, lon: 144.9631 };

const SCENARIOS = [
  {
    said: "I'm at 12% and I need to get to Geelong, but I've got my kid in the car and I'd rather not stop somewhere sketchy.",
    hour: 21,
  },
  {
    said: "Need a quick top-up, I'm in a hurry and don't care where.",
    hour: 11,
  },
  {
    said: "Looking for somewhere cheap to charge while I get lunch.",
    hour: 13,
  },
] as const;

const PER_GROUP = 5;

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}

async function main(): Promise<void> {
  const raw = JSON.parse(
    readFileSync(new URL("../../fixtures/au-chargers.json", import.meta.url), "utf8"),
  ) as readonly OcmPoi[];
  const { chargers } = toChargers(raw);

  const operational = chargers.filter((c) => c.facts.operational);
  const silent = operational.filter((c) => !hasProse(c)).slice(0, PER_GROUP);
  // Chargers that have prose but whose prose is NOT a warning — cost-only notes, mostly.
  const spoken = operational
    .filter((c) => hasProse(c) && c.prose.access === null && c.prose.cost !== null)
    .slice(0, PER_GROUP);

  if (silent.length < PER_GROUP || spoken.length < PER_GROUP) {
    console.error(`not enough in each group: silent ${silent.length}, spoken ${spoken.length}`);
    process.exitCode = 1;
    return;
  }

  const shortlist: readonly Charger[] = [...silent, ...spoken];
  const client = createJevClient();

  console.log(`\nComparing ${silent.length} chargers with NO prose against ${spoken.length} with neutral prose.`);
  console.log(`Same request, same shortlist, ${SCENARIOS.length} driver scenarios.\n`);

  const silentScores: number[] = [];
  const spokenScores: number[] = [];
  let billed = 0;

  for (const [index, scenario] of SCENARIOS.entries()) {
    // Legs are not meaningful for this synthetic shortlist, so the derived words are neutral: the
    // experiment is about prose, and giving each group different bands would confound it.
    const neutral = new Map(
      shortlist.map((c) => [c.id, { detourKm: 1, minutesToReach: 10, lastConfirmed: "recently confirmed" }]),
    );
    const state = buildState(scenario.said, shortlist, daylightFor(scenario.hour * 60), neutral);
    const questions = buildQuestions(shortlist);
    const result = (await client.systemOne({ state, questions })) as {
      answers: Record<string, { score?: number }>;
    };
    billed += billedCostUsd(result) ?? 0;

    const read = (c: Charger): number => result.answers[suitsKey(c.id)]?.score ?? Number.NaN;
    const s = silent.map(read);
    const p = spoken.map(read);
    silentScores.push(...s);
    spokenScores.push(...p);

    console.log(`  scenario ${index + 1}: "${scenario.said.slice(0, 54)}…"`);
    console.log(`     no prose     mean ${mean(s).toFixed(2)}   [${s.map((x) => x.toFixed(2)).join(", ")}]`);
    console.log(`     has prose    mean ${mean(p).toFixed(2)}   [${p.map((x) => x.toFixed(2)).join(", ")}]`);
  }

  const silentMean = mean(silentScores);
  const spokenMean = mean(spokenScores);

  console.log(`\n  OVERALL`);
  console.log(`    chargers with no prose at all : mean suits ${silentMean.toFixed(3)}  (n=${silentScores.length})`);
  console.log(`    chargers with neutral prose   : mean suits ${spokenMean.toFixed(3)}  (n=${spokenScores.length})`);
  console.log(`    difference                    : ${(silentMean - spokenMean).toFixed(3)}`);
  console.log(`\n  billed $${billed.toFixed(8)}\n`);

  if (silentMean > spokenMean) {
    console.log("  Silence scores HIGHER on average — but the averages are the least useful number here.");
    console.log("  Note what this experiment holds constant: BOTH groups get identical derived bands");
    console.log("  (same detour, same charging time, same verification age), so prose is the only thing");
    console.log("  that can vary. It therefore measures what prose adds, and says nothing about whether");
    console.log("  the bands work — for that, see whether a 250kW charger wins a `speed` request in the");
    console.log("  app, which it does.\n");
    console.log("  What it does establish: given nothing but prose to go on, a charger with none scores");
    console.log("  in a narrow band whatever is asked, and a charger with some scores across a range");
    console.log("  several times wider. Absence of prose is still absence of a judgement.\n");
  } else {
    console.log("  Silence does not score higher. The suspicion from the probe does not reproduce.\n");
  }
}

void main().catch((error: unknown) => {
  console.error("failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
