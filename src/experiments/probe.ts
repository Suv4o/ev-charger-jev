import { readFileSync } from "node:fs";

import "dotenv/config";

import { displayKm } from "../lib/geo/distance.ts";
import { billedCostUsd, createJevClient } from "../lib/jev/client.ts";
import { buildQuestions, buildState, daylightFor, parseTimeOfDay } from "../lib/jev/questions.ts";
import { toChargers } from "../lib/ocm/charger.ts";
import type { OcmPoi } from "../lib/ocm/types.ts";
import { buildPlan, derivedFactsFor, shortlist } from "../lib/plan/plan.ts";

/**
 * One real journey, end to end, through the same seam the app uses.
 *
 * Prints the two halves separately on purpose. The whole claim is that these are different kinds of
 * work, and a combined readout would hide which half did what.
 */

const MELBOURNE = { lat: -37.8136, lon: 144.9631 };
const GEELONG = { lat: -38.1499, lon: 144.3617 };

const DRIVER_SAID =
  "I'm at 12% and I need to get to Geelong, but I've got my kid in the car and I'd rather not stop somewhere sketchy.";
const ARRIVING_AT = "21:00";

const MARK: Record<string, string> = {
  recommended: "->",
  acceptable: "  ",
  unknown: " ?",
  warned: " !",
  ruled_out: " x",
};

async function main(): Promise<void> {
  const raw = JSON.parse(
    readFileSync(new URL("../../fixtures/au-chargers.json", import.meta.url), "utf8"),
  ) as readonly OcmPoi[];
  const { chargers } = toChargers(raw);

  // ── code's half ──────────────────────────────────────────────────────────────────────────
  const picked = shortlist(chargers, {
    origin: MELBOURNE,
    destination: GEELONG,
    batteryPercent: 12,
    fullRangeKm: 500,
    max: 8,
  });

  console.log(`\nCODE  ${chargers.length} chargers -> ${picked.shortlist.length} shortlisted`);
  console.log(`      ${displayKm(picked.rangeKm)}km of usable range at 12%, ${picked.eliminated} eliminated`);
  console.log(`      no model involved, nothing approximate\n`);

  if (picked.shortlist.length === 0) {
    console.log("  Nothing reachable. Nothing to ask.\n");
    return;
  }

  // ── the model's half ─────────────────────────────────────────────────────────────────────
  const arriving = daylightFor(parseTimeOfDay(ARRIVING_AT) ?? 0);
  const questions = buildQuestions(picked.shortlist);
  const now = Date.now();
  const derived = derivedFactsFor(picked.shortlist, picked.legs, picked.rangeKm, now);
  const state = buildState(DRIVER_SAID, picked.shortlist, arriving, derived);

  console.log(`JEV   ${Object.keys(questions).length} questions, one request, prose only`);
  console.log(`      "${DRIVER_SAID}"`);
  console.log(`      arriving ${arriving}\n`);

  const client = createJevClient();
  const startedAt = performance.now();
  const result = (await client.systemOne({ state, questions })) as {
    answers: Record<string, { score?: number; noul?: number; choice?: string; confidence?: number }>;
    usage: { input_tokens: number };
  };
  const elapsed = performance.now() - startedAt;

  const plan = buildPlan(picked.shortlist, picked.legs, result.answers, {
    afterDark: arriving === "after dark",
    filteredByCode: picked.eliminated,
    rangeKm: picked.rangeKm,
    now,
  });

  console.log(`PLAN  priority read as: ${plan.priority ?? "no preference stated"}\n`);
  for (const stop of plan.stops) {
    const kw = stop.maxPowerKw === null ? "  ?" : String(stop.maxPowerKw).padStart(3);
    console.log(
      `${MARK[stop.verdict] ?? "  "} ${stop.verdict.padEnd(12)} ${kw}kW ${String(stop.detourKm).padStart(5)}km  ${stop.charger.name}`,
    );
    console.log(`                  ${stop.reason}`);
    if (stop.evidence !== null) console.log(`                  notes: "${stop.evidence}"`);
  }

  console.log(
    `\n      ${Math.round(elapsed)}ms   ${result.usage.input_tokens} input tokens   $${(billedCostUsd(result) ?? 0).toFixed(8)}\n`,
  );
}

void main().catch((error: unknown) => {
  console.error("\nprobe failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
