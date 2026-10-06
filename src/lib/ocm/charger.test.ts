import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { hasProse, toCharger, toChargers } from "./charger.ts";
import type { OcmPoi } from "./types.ts";

/**
 * These run against a real Open Charge Map response, not hand-written objects.
 *
 * A fixture of invented POIs tests that the narrowing agrees with my idea of the API, which is the
 * thing most likely to be wrong. `fixtures/au-chargers.json` is 231 real Australian records —
 * everything within 45km of Melbourne or Geelong, plus every record in the country whose free text
 * contains a time constraint, because those are the ones the project exists to catch.
 */

const RAW = JSON.parse(
  readFileSync(new URL("../../../fixtures/au-chargers.json", import.meta.url), "utf8"),
) as readonly OcmPoi[];

describe("the fixture itself", () => {
  it("is real data, not a stub", () => {
    expect(RAW.length).toBeGreaterThan(200);
    // Every record is Australian and carries an OCM id.
    for (const poi of RAW) {
      expect(poi.ID).toBeGreaterThan(0);
      expect(poi.AddressInfo?.Country?.ISOCode).toBe("AU");
    }
  });
});

describe("toChargers", () => {
  const { chargers, dropped } = toChargers(RAW);

  it("narrows nearly everything, and reports what it could not", () => {
    expect(chargers.length).toBeGreaterThan(200);
    // Coordinates are 100% populated in the Australian set, so nothing should drop.
    expect(dropped).toBe(0);
  });

  it("gives every charger a finite position", () => {
    for (const c of chargers) {
      expect(Number.isFinite(c.position.lat)).toBe(true);
      expect(Number.isFinite(c.position.lon)).toBe(true);
      // Australia, roughly. Catches a lat/lon swap, which is the classic version of this bug.
      expect(c.position.lat).toBeLessThan(-9);
      expect(c.position.lat).toBeGreaterThan(-45);
      expect(c.position.lon).toBeGreaterThan(112);
      expect(c.position.lon).toBeLessThan(155);
    }
  });

  it("never invents a name", () => {
    for (const c of chargers) {
      expect(c.name.trim()).not.toBe("");
    }
  });
});

describe("the facts / prose split", () => {
  const { chargers } = toChargers(RAW);

  it("puts no number in prose", () => {
    // The guarantee the model's input depends on: every prose field is a string or null, never a
    // number that a caller could accidentally pass through as a digit.
    for (const c of chargers) {
      for (const value of [c.prose.access, c.prose.general, c.prose.cost]) {
        expect(value === null || typeof value === "string").toBe(true);
      }
      for (const comment of c.prose.userComments) {
        expect(typeof comment).toBe("string");
      }
    }
  });

  it("puts no free text in facts", () => {
    for (const c of chargers) {
      const { maxPowerKw, connectorCount, operational, membershipRequired } = c.facts;
      expect(maxPowerKw === null || typeof maxPowerKw === "number").toBe(true);
      expect(connectorCount === null || typeof connectorCount === "number").toBe(true);
      expect(typeof operational).toBe("boolean");
      expect(typeof membershipRequired).toBe("boolean");
    }
  });

  it("empty strings become null, so 'has information' is a real check", () => {
    for (const c of chargers) {
      for (const value of [c.prose.access, c.prose.general, c.prose.cost]) {
        if (value !== null) expect(value.trim()).toBe(value);
        expect(value).not.toBe("");
      }
    }
  });

  it("finds prose on most of the fixture, and admits when there is none", () => {
    const withProse = chargers.filter(hasProse);
    // The fixture was built to be prose-rich; the point is that some records still have none and
    // the type forces the caller to deal with that rather than rendering "null".
    expect(withProse.length).toBeGreaterThan(150);
    expect(withProse.length).toBeLessThan(chargers.length);
  });
});

describe("maxPowerKw", () => {
  const { chargers } = toChargers(RAW);

  it("is the maximum across connections, never the sum", () => {
    for (const c of chargers) {
      if (c.facts.maxPowerKw === null) continue;
      expect(c.facts.maxPowerKw).toBeGreaterThan(0);
      // No Australian public charger delivers more than 400kW today. A sum would blow past this on
      // any multi-stall site, so this is the assertion that catches the mistake.
      expect(c.facts.maxPowerKw).toBeLessThanOrEqual(400);
    }
  });
});

describe("toCharger rejects what it cannot use", () => {
  const base = RAW[0];
  if (base === undefined) throw new Error("fixture is empty");

  it("returns null with no AddressInfo", () => {
    expect(toCharger({ ...base, AddressInfo: null })).toBeNull();
  });

  it("returns null with no coordinates, rather than defaulting to 0,0", () => {
    const noCoords = {
      ...base,
      AddressInfo: { ...base.AddressInfo!, Latitude: null, Longitude: null },
    };
    expect(toCharger(noCoords)).toBeNull();
  });

  it("returns null on NaN coordinates", () => {
    const nan = { ...base, AddressInfo: { ...base.AddressInfo!, Latitude: Number.NaN } };
    expect(toCharger(nan)).toBeNull();
  });
});

describe("operational defaults to false", () => {
  const base = RAW[0];
  if (base === undefined) throw new Error("fixture is empty");

  it("treats an unknown status as not operational", () => {
    // The safe default. Recommending a charger whose status is unknown is the failure that costs a
    // driver a detour, so absence of evidence is not treated as evidence of working.
    const unknown = toCharger({ ...base, StatusType: null });
    expect(unknown?.facts.operational).toBe(false);
  });
});
