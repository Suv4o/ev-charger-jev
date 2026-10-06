import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { toChargers } from "../ocm/charger.ts";
import type { OcmPoi } from "../ocm/types.ts";
import { displayKm, haversineKm, isReachable, legFor, remainingRangeKm } from "./distance.ts";

const MELBOURNE = { lat: -37.8136, lon: 144.9631 };
const GEELONG = { lat: -38.1499, lon: 144.3617 };
const SYDNEY = { lat: -33.8688, lon: 151.2093 };

describe("haversineKm", () => {
  it("matches known Australian distances", () => {
    // Melbourne CBD to Geelong is 64.6km great-circle; the drive is ~75km, which is the gap this
    // module is honest about. Melbourne to Sydney is ~714km.
    expect(haversineKm(MELBOURNE, GEELONG)).toBeCloseTo(64.6, 1);
    expect(haversineKm(MELBOURNE, SYDNEY)).toBeCloseTo(714, -1);
  });

  it("is zero for the same point and symmetric", () => {
    expect(haversineKm(MELBOURNE, MELBOURNE)).toBe(0);
    expect(haversineKm(MELBOURNE, GEELONG)).toBeCloseTo(haversineKm(GEELONG, MELBOURNE), 9);
  });

  it("does not silently swap latitude and longitude", () => {
    const swapped = { lat: GEELONG.lon, lon: GEELONG.lat };
    expect(haversineKm(MELBOURNE, swapped)).toBeGreaterThan(1000);
  });
});

describe("remainingRangeKm", () => {
  it("derates, because a brochure figure is not a highway figure", () => {
    // 12% of a 500km car is 60km on paper; 48km once derated.
    expect(remainingRangeKm(12, 500)).toBeCloseTo(48, 5);
  });

  it("clamps nonsense input rather than returning nonsense", () => {
    expect(remainingRangeKm(-5, 500)).toBe(0);
    expect(remainingRangeKm(140, 500)).toBe(remainingRangeKm(100, 500));
  });
});

describe("legFor", () => {
  const charger = {
    id: 1,
    name: "test",
    town: null,
    state: null,
    position: { lat: -37.9, lon: 144.7 },
    facts: {
      maxPowerKw: 50,
      connectorCount: 2,
      connectors: [],
      operational: true,
      membershipRequired: false,
      payAtLocation: false,
      operator: null,
      recentlyVerified: true,
      lastVerifiedAt: "2026-09-01T00:00:00Z",
    },
    prose: { access: null, general: null, cost: null, userComments: [] },
    licence: null,
  };

  it("detour is the extra distance over driving straight there", () => {
    const leg = legFor(charger, MELBOURNE, GEELONG);
    const direct = haversineKm(MELBOURNE, GEELONG);
    expect(leg.fromOriginKm + leg.toDestinationKm - direct).toBeCloseTo(leg.detourKm, 9);
  });

  it("never reports a negative detour", () => {
    // A charger sitting exactly on the straight line is the case that can go slightly negative.
    const onTheLine = {
      ...charger,
      position: {
        lat: (MELBOURNE.lat + GEELONG.lat) / 2,
        lon: (MELBOURNE.lon + GEELONG.lon) / 2,
      },
    };
    expect(legFor(onTheLine, MELBOURNE, GEELONG).detourKm).toBeGreaterThanOrEqual(0);
  });
});

describe("isReachable", () => {
  it("holds back a reserve rather than driving to empty", () => {
    const leg = { fromOriginKm: 50, toDestinationKm: 0, detourKm: 0 };
    // 50km away on 55km of range: within range on paper, refused once 15% is held back.
    expect(isReachable(leg, 55)).toBe(false);
    expect(isReachable(leg, 60)).toBe(true);
  });
});

describe("displayKm", () => {
  it("keeps one decimal when close and rounds when far", () => {
    expect(displayKm(4.23)).toBe(4.2);
    expect(displayKm(41.6)).toBe(42);
  });
});

/**
 * The boundary this project is built on, asserted rather than assumed.
 *
 * The arithmetic layer must never reach the model layer. A stray import would not fail any other
 * test — it would just quietly make it possible to hand a kilowatt figure to a decision model.
 */
describe("the arithmetic layer is model-free", () => {
  it("imports nothing from the jev layer", () => {
    const dir = new URL("./", import.meta.url);
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(new URL(file, dir), "utf8");
      expect(text).not.toMatch(/from\s+["'].*\/jev\//);
      expect(text).not.toMatch(/@typesafe-ai/);
    }
  });
});

describe("against the real fixture", () => {
  const RAW = JSON.parse(
    readFileSync(new URL("../../../fixtures/au-chargers.json", import.meta.url), "utf8"),
  ) as readonly OcmPoi[];
  const { chargers } = toChargers(RAW);

  it("every charger produces a finite, non-negative leg", () => {
    for (const c of chargers) {
      const leg = legFor(c, MELBOURNE, GEELONG);
      expect(Number.isFinite(leg.fromOriginKm)).toBe(true);
      expect(Number.isFinite(leg.detourKm)).toBe(true);
      expect(leg.detourKm).toBeGreaterThanOrEqual(0);
    }
  });

  it("finds real chargers within reach of a 12% battery near Melbourne", () => {
    const range = remainingRangeKm(12, 500); // 48km
    const reachable = chargers.filter((c) => isReachable(legFor(c, MELBOURNE, GEELONG), range));
    // The fixture is Melbourne/Geelong-centred, so this must not be empty or everything.
    expect(reachable.length).toBeGreaterThan(5);
    expect(reachable.length).toBeLessThan(chargers.length);
  });
});
