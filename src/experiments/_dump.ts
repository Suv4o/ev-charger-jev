import "dotenv/config";
import { createJevClient } from "../lib/jev/client.ts";
import { buildQuestions, buildState, daylightFor, suitsKey } from "../lib/jev/questions.ts";
import { fetchChargers } from "../lib/ocm/client.ts";
import { derivedFactsFor, shortlist } from "../lib/plan/plan.ts";

const MEL = { lat: -37.8136, lon: 144.9631 };
const GEE = { lat: -38.1499, lon: 144.3617 };
const SAID = "Only 8% left and I need to be in Geelong. Absolute fastest charger, I cannot wait around.";

async function main(): Promise<void> {
  const src = await fetchChargers({ origin: MEL, destination: GEE, maxResults: 600 });
  const picked = shortlist(src.chargers, { origin: MEL, destination: GEE, batteryPercent: 8, fullRangeKm: 500, max: 8 });
  const now = Date.now();
  const derived = derivedFactsFor(picked.shortlist, picked.legs, picked.rangeKm, now);
  const state = buildState(SAID, picked.shortlist, daylightFor(17 * 60 + 45), derived);
  const questions = buildQuestions(picked.shortlist);

  console.log("=== STATE (what Jev sees) ===");
  console.log(JSON.stringify(state, null, 2).slice(0, 2400));
  console.log("\n=== the `best` QUESTION ===");
  console.log(JSON.stringify((questions as Record<string, unknown>)["best"], null, 2));

  const r = (await createJevClient().systemOne({ state, questions })) as {
    answers: Record<string, { score?: number; choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
  };

  console.log("\n=== the `best` ANSWER ===");
  const best = r.answers["best"];
  console.log("choice:", best?.choice, " confidence:", best?.confidence?.toFixed(3));
  console.log("probabilities:");
  const probs = Object.entries(best?.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
  for (const [id, p] of probs) {
    const name = picked.shortlist.find((c) => String(c.id) === id)?.name ?? id;
    const kw = picked.shortlist.find((c) => String(c.id) === id)?.facts.maxPowerKw ?? "?";
    console.log(`  ${p.toFixed(4)}  ${String(kw).padStart(4)}kW  ${name}`);
  }
  console.log("\n=== suits scores ===");
  for (const c of picked.shortlist) {
    console.log(`  ${r.answers[suitsKey(c.id)]?.score?.toFixed(2)}  ${String(c.facts.maxPowerKw ?? "?").padStart(4)}kW  ${c.name}`);
  }
}
void main();
