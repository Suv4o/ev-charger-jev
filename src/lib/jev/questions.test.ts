import { describe, expect, it } from "vitest";

import { daylightFor, parseTimeOfDay } from "./questions.ts";

describe("daylightFor", () => {
  const at = (h: number, m = 0) => daylightFor(h * 60 + m);

  it("splits the day into three words the model can read", () => {
    expect(at(9)).toBe("in daylight");
    expect(at(16, 59)).toBe("in daylight");
    expect(at(17)).toBe("around dusk");
    expect(at(18, 59)).toBe("around dusk");
    expect(at(19)).toBe("after dark");
    expect(at(3)).toBe("after dark");
    expect(at(6, 59)).toBe("after dark");
    expect(at(7)).toBe("in daylight");
  });

  it("honours minutes now that the input is a real time", () => {
    // The old hour-only version rounded both of these to "around dusk".
    expect(at(16, 30)).toBe("in daylight");
    expect(at(19, 1)).toBe("after dark");
  });

  it("wraps rather than throwing on nonsense", () => {
    expect(at(24)).toBe("after dark");
    expect(daylightFor(-60)).toBe("after dark");
  });
});

describe("parseTimeOfDay", () => {
  it("reads what an <input type=time> sends", () => {
    expect(parseTimeOfDay("21:30")).toBe(1290);
    expect(parseTimeOfDay("00:00")).toBe(0);
    expect(parseTimeOfDay("9:05")).toBe(545);
  });

  it("rejects anything that is not a time", () => {
    for (const bad of ["", "21", "21:60", "24:00", "nine", "21:30:00"]) {
      expect(parseTimeOfDay(bad)).toBeNull();
    }
  });
});
