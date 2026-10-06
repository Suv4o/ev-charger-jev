import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Leg } from "../geo/distance.ts";
import { costKey, suitsKey, timeLimitedKey } from "../jev/questions.ts";
import { toChargers, type Charger } from "../ocm/charger.ts";
import type { OcmPoi } from "../ocm/types.ts";
import { buildPlan, shortlist } from "./plan.ts";

const RAW = JSON.parse(
  readFileSync(new URL("../../../fixtures/au-chargers.json", import.meta.url), "utf8"),
) as readonly OcmPoi[];
const { chargers } = toChargers(RAW);

const MELBOURNE = { lat: -37.8136, lon: 144.9631 };
const GEELONG = { lat: -38.1499, lon: 144.3617 };
const LEG: Leg = { fromOriginKm: 5, toDestinationKm: 60, detourKm: 1 };

/** Fixed clock. A plan must be a pure function of its inputs, staleness included. */
const NOW = Date.parse("2026-09-26T00:00:00Z");

function legsFor(cs: readonly Charger[]): Map<number, Leg> {
  return new Map(cs.map((c) => [c.id, LEG]));
}

/** A charger with prose, and one without, taken from the real fixture. */
const withProse = chargers.find((c) => c.prose.access !== null && c.facts.operational);
const withoutProse = chargers.find(
  (c) => c.prose.access === null && c.prose.general === null && c.prose.cost === null,
);
if (withProse === undefined || withoutProse === undefined) {
  throw new Error("fixture does not contain both a documented and an undocumented charger");
}

describe("shortlist — code's half", () => {
  it("eliminates most of the set before the model is asked anything", () => {
    const result = shortlist(chargers, {
      origin: MELBOURNE,
      destination: GEELONG,
      batteryPercent: 12,
      fullRangeKm: 500,
      max: 8,
    });
    expect(result.shortlist.length).toBeLessThanOrEqual(8);
    expect(result.shortlist.length).toBeGreaterThan(0);
    expect(result.eliminated).toBeGreaterThan(200);
    expect(result.rangeKm).toBeCloseTo(48, 5);
  });

  it("never shortlists a charger that is not operational", () => {
    const result = shortlist(chargers, {
      origin: MELBOURNE,
      destination: GEELONG,
      batteryPercent: 90,
      fullRangeKm: 500,
      max: 50,
    });
    for (const c of result.shortlist) expect(c.facts.operational).toBe(true);
  });
});

/**
 * Finding 4, revised by finding 16.
 *
 * The original gate refused to recommend a charger nobody had written about, because its Score was
 * really "I don't know" dressed up as a mild yes. That reasoning held while the model saw nothing but
 * human prose. Code now phrases its own facts as words, so an undocumented charger is no longer an
 * information-free one — and the absence of human notes became a caveat the card states rather than a
 * veto applied on the model's behalf.
 *
 * What still has to be true: the reader is told, in plain words, that nobody has written about it.
 */
describe("finding 4 (revised) — an undocumented charger says so", () => {
  const answers = {
    best: { probabilities: { [String(withoutProse.id)]: 0.9 } },
    priority: { choice: "safety" },
    [suitsKey(withoutProse.id)]: { score: 2.1 },
    [timeLimitedKey(withoutProse.id)]: { noul: 0.03 },
    [costKey(withoutProse.id)]: { choice: "not_stated" },
  };
  const ctx = { afterDark: false, filteredByCode: 100, rangeKm: 48, now: NOW };

  it("can be recommended now that code describes it", () => {
    const plan = buildPlan([withoutProse], legsFor([withoutProse]), answers, ctx);
    expect(plan.stops[0]?.verdict).toBe("recommended");
  });

  it("names the missing notes when it is merely acceptable", () => {
    const plan = buildPlan([withoutProse], legsFor([withoutProse]), { ...answers, best: {} }, ctx);
    expect(plan.stops[0]?.verdict).toBe("acceptable");
    expect(plan.stops[0]?.reason).toContain("Nobody has written");
  });

  it("says Jev judged it, not its notes, when it is ruled out", () => {
    const plan = buildPlan(
      [withoutProse],
      legsFor([withoutProse]),
      { ...answers, [suitsKey(withoutProse.id)]: { score: 0.5 } },
      ctx,
    );
    expect(plan.stops[0]?.verdict).toBe("ruled_out");
    expect(plan.stops[0]?.reason).toContain("Jev judged it");
  });
});

describe("finding 2 — a time restriction the driver would arrive outside", () => {
  const answers = {
    best: { choice: String(withProse.id), confidence: 0.5 },
    priority: { choice: "safety", confidence: 0.9 },
    [suitsKey(withProse.id)]: { score: 2.4 },
    [timeLimitedKey(withProse.id)]: { noul: 0.99 },
    [costKey(withProse.id)]: { choice: "typical" },
  };

  it("rules it out after dark, whatever the suits score says", () => {
    const plan = buildPlan([withProse], legsFor([withProse]), answers, {
      afterDark: true,
      filteredByCode: 0,
      rangeKm: 48,
      now: NOW,
    });
    expect(plan.stops[0]?.verdict).toBe("ruled_out");
    expect(plan.stops[0]?.timeRisk).toBe(true);
  });

  it("only warns in daylight — the restriction exists but does not bite", () => {
    const plan = buildPlan([withProse], legsFor([withProse]), answers, {
      afterDark: false,
      filteredByCode: 0,
      rangeKm: 48,
      now: NOW,
    });
    expect(plan.stops[0]?.verdict).toBe("warned");
    expect(plan.stops[0]?.timeRisk).toBe(false);
  });

  it("overrides the model naming it best — code owns this gate", () => {
    const plan = buildPlan([withProse], legsFor([withProse]), answers, {
      afterDark: true,
      filteredByCode: 0,
      rangeKm: 48,
      now: NOW,
    });
    expect(plan.stops[0]?.verdict).not.toBe("recommended");
  });
});

describe("no raw answer escapes the seam", () => {
  it("a plan carries no probability, score or confidence", () => {
    const plan = buildPlan(
      [withProse],
      legsFor([withProse]),
      {
        best: { choice: String(withProse.id), confidence: 0.77 },
        priority: { choice: "safety", confidence: 0.91 },
        [suitsKey(withProse.id)]: { score: 2.1 },
        [timeLimitedKey(withProse.id)]: { noul: 0.04 },
        [costKey(withProse.id)]: { choice: "cheap" },
      },
      { afterDark: false, filteredByCode: 0, rangeKm: 48, now: NOW },
    );
    const serialised = JSON.stringify(plan);
    for (const leaked of ["confidence", "probabilities", "noul", "0.77", "0.91", "2.1"]) {
      expect(serialised).not.toContain(leaked);
    }
  });
});

describe("missing answers degrade rather than throw", () => {
  it("treats an absent judgement as unknown", () => {
    const plan = buildPlan([withProse], legsFor([withProse]), {}, {
      afterDark: false,
      filteredByCode: 0,
      rangeKm: 48,
      now: NOW,
    });
    expect(plan.stops[0]?.verdict).toBe("unknown");
    expect(plan.priority).toBeNull();
  });
});

/**
 * Finding 9, as a regression test.
 *
 * `priority` used to be read and then dropped. It now gates on staleness — but only for a driver who
 * asked for something dependable, because applying it to everyone would eliminate 75% of the dataset.
 */
describe("finding 9 — staleness gates only when reliability was asked for", () => {
  const ancient = {
    ...withProse,
    facts: { ...withProse.facts, lastVerifiedAt: "2019-01-04T00:00:00Z", recentlyVerified: false },
  };
  const answersFor = (priority: string) => ({
    best: { choice: String(ancient.id), confidence: 0.6 },
    priority: { choice: priority, confidence: 0.95 },
    [suitsKey(ancient.id)]: { score: 2.3 },
    [timeLimitedKey(ancient.id)]: { noul: 0.02 },
    [costKey(ancient.id)]: { choice: "cheap" },
  });
  const ctx = { afterDark: false, filteredByCode: 0, rangeKm: 48, now: NOW };

  it("warns a reliability-minded driver about a seven-year-old record", () => {
    const plan = buildPlan([ancient], legsFor([ancient]), answersFor("reliability"), ctx);
    expect(plan.stops[0]?.verdict).toBe("warned");
    expect(plan.stops[0]?.reason).toContain("dependable");
  });

  it("does not warn a cost-minded driver about the same record", () => {
    const plan = buildPlan([ancient], legsFor([ancient]), answersFor("cost"), ctx);
    // Same charger, same data, same score. Only the stated priority differs.
    expect(plan.stops[0]?.verdict).toBe("recommended");
  });

  it("does not warn a reliability-minded driver about a fresh record", () => {
    const fresh = {
      ...withProse,
      facts: { ...withProse.facts, lastVerifiedAt: "2026-08-01T00:00:00Z", recentlyVerified: true },
    };
    const plan = buildPlan([fresh], legsFor([fresh]), answersFor("reliability"), ctx);
    expect(plan.stops[0]?.verdict).toBe("recommended");
  });

  it("computes freshness for every stop regardless of priority", () => {
    const plan = buildPlan([ancient], legsFor([ancient]), answersFor("cost"), ctx);
    expect(plan.stops[0]?.freshness).toBe("abandoned");
    expect(plan.stops[0]?.freshnessLabel).toContain("five years");
  });
});

/**
 * Finding 7, as a regression test.
 *
 * `best.choice` is often an undocumented charger that gate 2 demotes, which used to leave nothing
 * recommended. The probabilities cover every option, so the recommendation is now the highest-rated
 * option that actually survived the gates.
 */
describe("finding 7 — the recommendation uses probabilities, not the argmax", () => {
  const both = [withoutProse, withProse];
  const ctx = { afterDark: false, filteredByCode: 0, rangeKm: 48, now: NOW };

  it("recommends the best SURVIVING option when the argmax was gated out", () => {
    const plan = buildPlan(
      both,
      legsFor(both),
      {
        best: {
          // The model liked one the score gate then rejected.
          choice: String(withoutProse.id),
          probabilities: { [String(withoutProse.id)]: 0.7, [String(withProse.id)]: 0.3 },
        },
        priority: { choice: "safety" },
        [suitsKey(withProse.id)]: { score: 2.2 },
        [timeLimitedKey(withProse.id)]: { noul: 0.02 },
        [costKey(withProse.id)]: { choice: "typical" },
        // Below threshold, so no amount of probability may promote it.
        [suitsKey(withoutProse.id)]: { score: 0.6 },
        [timeLimitedKey(withoutProse.id)]: { noul: 0.03 },
        [costKey(withoutProse.id)]: { choice: "not_stated" },
      },
      ctx,
    );
    const recommended = plan.stops.find((s) => s.verdict === "recommended");
    expect(recommended?.charger.id).toBe(withProse.id);
    // The one the model actually rated highest is still shown, still honestly labelled.
    expect(plan.stops.find((s) => s.charger.id === withoutProse.id)?.verdict).toBe("ruled_out");
  });

  it("recommends nothing when no option survives the gates", () => {
    const plan = buildPlan(
      [withoutProse],
      legsFor([withoutProse]),
      {
        best: { choice: String(withoutProse.id), probabilities: { [String(withoutProse.id)]: 0.9 } },
        priority: { choice: "safety" },
        [suitsKey(withoutProse.id)]: { score: 0.9 },
        [timeLimitedKey(withoutProse.id)]: { noul: 0.02 },
        [costKey(withoutProse.id)]: { choice: "not_stated" },
      },
      ctx,
    );
    expect(plan.stops.some((s) => s.verdict === "recommended")).toBe(false);
  });

  it("never promotes a stop a gate rejected, even at probability 1.0", () => {
    const plan = buildPlan(
      [withProse],
      legsFor([withProse]),
      {
        best: { choice: String(withProse.id), probabilities: { [String(withProse.id)]: 1.0 } },
        priority: { choice: "safety" },
        [suitsKey(withProse.id)]: { score: 0.4 },
        [timeLimitedKey(withProse.id)]: { noul: 0.02 },
        [costKey(withProse.id)]: { choice: "typical" },
      },
      ctx,
    );
    expect(plan.stops[0]?.verdict).toBe("ruled_out");
  });
});

/**
 * Finding 10.
 *
 * Undocumented chargers have no prose to rank by, but they do have a verification date. Ordering the
 * `unknown` band by freshness surfaces the one that is actually known to work recently, instead of
 * whichever happens to be quickest to reach.
 */
describe("finding 10 — the unknown band orders by verification age", () => {
  const ctx = { afterDark: false, filteredByCode: 0, rangeKm: 48, now: NOW };
  const bare = (id: number, lastVerifiedAt: string, kw: number): Charger => ({
    ...withoutProse,
    id,
    name: `bare-${id}`,
    facts: { ...withoutProse.facts, lastVerifiedAt, maxPowerKw: kw, recentlyVerified: false },
    prose: { access: null, general: null, cost: null, userComments: [] },
  });

  it("puts a recently confirmed charger above a faster but ancient one", () => {
    // The ancient one is far more powerful, so a time-only sort would rank it first.
    //
    // `safety` on purpose: under `reliability` a fresh record now counts as relevant evidence and the
    // fresh one is promoted out of the unknown band entirely, which is a different rule (below).
    // Safety can only be answered from prose, so both stay unknown and this tests the ordering.
    const ancientFast = bare(9001, "2018-01-01T00:00:00Z", 350);
    const freshSlow = bare(9002, "2026-08-15T00:00:00Z", 22);
    const both = [ancientFast, freshSlow];
    const plan = buildPlan(both, legsFor(both), { priority: { choice: "safety" } }, ctx);

    expect(plan.stops.map((s) => s.verdict)).toEqual(["unknown", "unknown"]);
    expect(plan.stops[0]?.charger.id).toBe(freshSlow.id);
    expect(plan.stops[0]?.freshness).toBe("fresh");
  });

  it("still orders judged stops by time, not by freshness", () => {
    const fresh = {
      ...withProse,
      id: 9101,
      facts: { ...withProse.facts, lastVerifiedAt: "2026-09-01T00:00:00Z", maxPowerKw: 11 },
    };
    const old = {
      ...withProse,
      id: 9102,
      facts: { ...withProse.facts, lastVerifiedAt: "2019-01-01T00:00:00Z", maxPowerKw: 350 },
    };
    const both = [fresh, old];
    const answers = {
      priority: { choice: "cost" },
      best: { probabilities: { "9101": 0.1, "9102": 0.9 } },
      [suitsKey(9101)]: { score: 2.0 },
      [timeLimitedKey(9101)]: { noul: 0.01 },
      [costKey(9101)]: { choice: "typical" },
      [suitsKey(9102)]: { score: 2.0 },
      [timeLimitedKey(9102)]: { noul: 0.01 },
      [costKey(9102)]: { choice: "typical" },
    };
    const plan = buildPlan(both, legsFor(both), answers, ctx);
    // 9102 is recommended (highest probability, survived the gates) and also the faster charger.
    expect(plan.stops[0]?.charger.id).toBe(9102);
  });
});

describe("the hero — the one the interface leads with", () => {
  const ctx = { afterDark: false, filteredByCode: 0, rangeKm: 48, now: NOW };

  it("is the recommendation when there is one", () => {
    const plan = buildPlan(
      [withProse],
      legsFor([withProse]),
      {
        best: { probabilities: { [String(withProse.id)]: 0.8 } },
        priority: { choice: "cost" },
        [suitsKey(withProse.id)]: { score: 2.2 },
        [timeLimitedKey(withProse.id)]: { noul: 0.01 },
        [costKey(withProse.id)]: { choice: "free" },
      },
      ctx,
    );
    expect(plan.stops[0]?.verdict).toBe("recommended");
    expect(plan.stops[0]?.hero).toBe(true);
  });

  it("falls back to the top acceptable stop when nothing was recommended", () => {
    // No probabilities and no choice, so nothing gets promoted — but one stop still cleared.
    const plan = buildPlan(
      [withProse],
      legsFor([withProse]),
      {
        priority: { choice: "cost" },
        [suitsKey(withProse.id)]: { score: 2.2 },
        [timeLimitedKey(withProse.id)]: { noul: 0.01 },
        [costKey(withProse.id)]: { choice: "typical" },
      },
      ctx,
    );
    expect(plan.stops[0]?.verdict).toBe("acceptable");
    expect(plan.stops[0]?.hero).toBe(true);
  });

  it("has no hero when nothing cleared the gates", () => {
    const plan = buildPlan(
      [withoutProse],
      legsFor([withoutProse]),
      {
        priority: { choice: "safety" },
        // Below threshold: rejected by the score gate, so nothing is admissible.
        [suitsKey(withoutProse.id)]: { score: 0.9 },
        [timeLimitedKey(withoutProse.id)]: { noul: 0.01 },
        [costKey(withoutProse.id)]: { choice: "not_stated" },
      },
      ctx,
    );
    expect(plan.stops.every((s) => !s.hero)).toBe(true);
  });

  it("marks exactly one hero, never more", () => {
    const many = [withProse, { ...withProse, id: 8001 }, { ...withProse, id: 8002 }];
    const answers: Record<string, unknown> = { priority: { choice: "cost" } };
    for (const c of many) {
      answers[suitsKey(c.id)] = { score: 2.2 };
      answers[timeLimitedKey(c.id)] = { noul: 0.01 };
      answers[costKey(c.id)] = { choice: "typical" };
    }
    const plan = buildPlan(many, legsFor(many), answers as never, ctx);
    expect(plan.stops.filter((s) => s.hero)).toHaveLength(1);
  });
});


/**
 * Finding 14, narrowed by finding 16.
 *
 * Code no longer picks the winner, so the original claim — that `speed` should rank on total time
 * rather than time at the plug — no longer applies to the recommendation. What survives is that the
 * LIST is ordered by total added time, so a reader is not shown a slower option above a faster one
 * within the same verdict band.
 */
describe("finding 14 (narrowed) — the list is ordered by total added time", () => {
  const ctx = { afterDark: false, filteredByCode: 0, rangeKm: 48, now: NOW };

  it("puts the option with the lower total first within a band", () => {
    // Laverton 250kW, 0.7km off route -> lower total. Werribee 180kW, 1.7km off route -> higher.
    const laverton = { ...withProse, id: 6001, name: "laverton", facts: { ...withProse.facts, maxPowerKw: 250 } };
    const werribee = { ...withProse, id: 6002, name: "werribee", facts: { ...withProse.facts, maxPowerKw: 180 } };
    const legs = new Map<number, Leg>([
      [6001, { fromOriginKm: 18, toDestinationKm: 47, detourKm: 0.7 }],
      [6002, { fromOriginKm: 28, toDestinationKm: 38, detourKm: 1.7 }],
    ]);
    const plan = buildPlan(
      [laverton, werribee],
      legs,
      {
        priority: { choice: "speed" },
        [suitsKey(6001)]: { score: 2.0 },
        [timeLimitedKey(6001)]: { noul: 0.01 },
        [costKey(6001)]: { choice: "typical" },
        [suitsKey(6002)]: { score: 2.0 },
        [timeLimitedKey(6002)]: { noul: 0.01 },
        [costKey(6002)]: { choice: "typical" },
      },
      ctx,
    );
    const total = (id: number) => {
      const stop = plan.stops.find((x) => x.charger.id === id);
      return stop!.detourKm * 1.2 + (stop!.minutesToReach ?? Infinity);
    };
    expect(total(6001)).toBeLessThan(total(6002));
    // Neither was recommended (no probabilities given), so both sit in the same band, ordered by time.
    expect(plan.stops[0]?.charger.id).toBe(6001);
  });
});

/**
 * Finding 16.
 *
 * Nothing is ever chosen by code. Code filters, refuses, and phrases its numbers as words; the Choice
 * picks the winner from what survives. Superseding findings 9, 10 and 12, which had code choosing
 * whenever the priority was measurable.
 */
describe("finding 16 — Jev picks the winner, always", () => {
  const ctx = { afterDark: false, filteredByCode: 0, rangeKm: 48, now: NOW };
  const legs = new Map<number, Leg>([
    [4001, { fromOriginKm: 10, toDestinationKm: 100, detourKm: 1 }],
    [4002, { fromOriginKm: 12, toDestinationKm: 98, detourKm: 1.2 }],
  ]);
  const slowButLiked = { ...withProse, id: 4001, name: "slow", facts: { ...withProse.facts, maxPowerKw: 11 } };
  const fastButNot = { ...withProse, id: 4002, name: "fast", facts: { ...withProse.facts, maxPowerKw: 250 } };
  const both = [slowButLiked, fastButNot];

  const answers = (priority: string) => ({
    priority: { choice: priority },
    // The model prefers the SLOW one. Code must not overrule that any more.
    best: { probabilities: { "4001": 0.85, "4002": 0.15 } },
    [suitsKey(4001)]: { score: 2.1 },
    [timeLimitedKey(4001)]: { noul: 0.01 },
    [costKey(4001)]: { choice: "cheap" },
    [suitsKey(4002)]: { score: 2.0 },
    [timeLimitedKey(4002)]: { noul: 0.01 },
    [costKey(4002)]: { choice: "typical" },
  });

  it("honours the model's pick even when the driver asked for speed", () => {
    const plan = buildPlan(both, legs, answers("speed"), ctx);
    expect(plan.stops.find((s) => s.verdict === "recommended")?.charger.id).toBe(4001);
  });

  it("honours the model's pick when the driver asked for reliability", () => {
    const plan = buildPlan(both, legs, answers("reliability"), ctx);
    expect(plan.stops.find((s) => s.verdict === "recommended")?.charger.id).toBe(4001);
  });

  it("gives the same answer for every priority, because only the model decides", () => {
    const winners = ["speed", "reliability", "safety", "cost", "amenities"].map(
      (p) => buildPlan(both, legs, answers(p), ctx).stops.find((s) => s.verdict === "recommended")?.charger.id,
    );
    expect(new Set(winners).size).toBe(1);
  });

  it("an undocumented charger can now be recommended, with the caveat stated", () => {
    // Previously blocked outright. Code phrases its own facts as words, so the model has something to
    // judge and the absence of human notes is a caveat rather than a veto.
    const bare = { ...withoutProse, id: 4003, name: "bare", facts: { ...withoutProse.facts, maxPowerKw: 250 } };
    const plan = buildPlan(
      [bare],
      new Map([[4003, { fromOriginKm: 10, toDestinationKm: 100, detourKm: 1 }]]),
      {
        priority: { choice: "safety" },
        best: { probabilities: { "4003": 0.9 } },
        [suitsKey(4003)]: { score: 2.1 },
        [timeLimitedKey(4003)]: { noul: 0.01 },
        [costKey(4003)]: { choice: "not_stated" },
      },
      ctx,
    );
    expect(plan.stops[0]?.verdict).toBe("recommended");
  });

  it("still refuses what the gates refuse, whatever the model wanted", () => {
    const plan = buildPlan(
      [slowButLiked],
      legs,
      { ...answers("speed"), [suitsKey(4001)]: { score: 0.4 } },
      ctx,
    );
    expect(plan.stops[0]?.verdict).toBe("ruled_out");
  });
});

describe("the undocumented caveat survives promotion", () => {
  const ctx = { afterDark: false, filteredByCode: 0, rangeKm: 48, now: NOW };

  it("says so on the winning card, not just on also-rans", () => {
    const bare = { ...withoutProse, id: 3001, facts: { ...withoutProse.facts, maxPowerKw: 250 } };
    const plan = buildPlan(
      [bare],
      new Map([[3001, { fromOriginKm: 10, toDestinationKm: 100, detourKm: 1 }]]),
      {
        priority: { choice: "speed" },
        best: { probabilities: { "3001": 0.95 } },
        [suitsKey(3001)]: { score: 2.3 },
        [timeLimitedKey(3001)]: { noul: 0.01 },
        [costKey(3001)]: { choice: "not_stated" },
      },
      ctx,
    );
    expect(plan.stops[0]?.verdict).toBe("recommended");
    expect(plan.stops[0]?.reason).toContain("nobody has written anything");
  });

  it("does not add the caveat to a documented winner", () => {
    const plan = buildPlan(
      [withProse],
      legsFor([withProse]),
      {
        priority: { choice: "cost" },
        best: { probabilities: { [String(withProse.id)]: 0.9 } },
        [suitsKey(withProse.id)]: { score: 2.3 },
        [timeLimitedKey(withProse.id)]: { noul: 0.01 },
        [costKey(withProse.id)]: { choice: "free" },
      },
      ctx,
    );
    expect(plan.stops[0]?.reason).not.toContain("nobody has written");
  });
});
