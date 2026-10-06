import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { applyMapTheme, MAP_BACKGROUND, themeStyle, type ThemeableMap } from "./theme.ts";

/**
 * Run against the real published style, captured from OpenFreeMap.
 *
 * The risk this guards is specific: the rules match layer ids by substring, so an upstream rename
 * would silently turn the theming into a partial no-op and the map would come back grey in patches.
 * Counting painted layers catches that; asserting against a hand-written list of ids would not.
 */
const STYLE = JSON.parse(readFileSync(new URL("./liberty-layers.json", import.meta.url), "utf8")) as {
  layers: { id: string; type: string }[];
};

function fakeMap(layers: { id: string; type: string }[]): {
  map: ThemeableMap;
  painted: Map<string, Record<string, unknown>>;
} {
  const painted = new Map<string, Record<string, unknown>>();
  const map: ThemeableMap = {
    getStyle: () => ({ layers }),
    setPaintProperty: (layer, property, value) => {
      const existing = painted.get(layer) ?? {};
      existing[property] = value;
      painted.set(layer, existing);
    },
  };
  return { map, painted };
}

describe("applyMapTheme against the real liberty style", () => {
  it("has a style fixture with the layers it claims", () => {
    expect(STYLE.layers.length).toBeGreaterThan(100);
  });

  it("paints every single layer — no grey patches left behind", () => {
    const { map } = fakeMap(STYLE.layers);
    expect(applyMapTheme(map)).toBe(STYLE.layers.length);
  });

  it("sets the background to the app's ground colour", () => {
    const { map, painted } = fakeMap(STYLE.layers);
    applyMapTheme(map);
    expect(painted.get("background")?.["background-color"]).toBe(MAP_BACKGROUND);
  });

  it("colours water with the palette's green-blue, not a road colour", () => {
    const { map, painted } = fakeMap(STYLE.layers);
    applyMapTheme(map);
    expect(painted.get("water")?.["fill-color"]).toBe("#bfd9db");
  });

  it("treats waterway_tunnel as water, not as a tunnel", () => {
    // The ordering trap: the id contains both "water" and "tunnel".
    const { map, painted } = fakeMap(STYLE.layers);
    applyMapTheme(map);
    expect(painted.get("waterway_tunnel")?.["line-color"]).toBe("#bfd9db");
  });

  it("gives labels the navy text and beige halo used in the sidebar", () => {
    const { map, painted } = fakeMap(STYLE.layers);
    applyMapTheme(map);
    const label = painted.get("label_town");
    expect(label?.["text-color"]).toBe("#173353");
    expect(label?.["text-halo-color"]).toBe("#efe8df");
  });

  it("hides the raster layer rather than letting grey muddy the palette", () => {
    const raster = STYLE.layers.find((l) => l.type === "raster");
    expect(raster).toBeDefined();
    const { map, painted } = fakeMap(STYLE.layers);
    applyMapTheme(map);
    expect(painted.get(raster!.id)?.["raster-opacity"]).toBe(0);
  });

  it("survives a layer whose paint property throws", () => {
    const map: ThemeableMap = {
      getStyle: () => ({ layers: [{ id: "awkward", type: "fill" }] }),
      setPaintProperty: () => {
        throw new Error("no such property");
      },
    };
    expect(() => applyMapTheme(map)).not.toThrow();
  });

  it("returns 0 on an empty or unavailable style rather than throwing", () => {
    expect(applyMapTheme({ getStyle: () => undefined, setPaintProperty: () => {} })).toBe(0);
  });

  /**
   * The trap the count test caught.
   *
   * `highway-name-path` is a SYMBOL layer whose id contains "path", so matching on the id alone gave
   * it the road rule — which only defines a line colour — and it came away with nothing. Seven label
   * layers were keeping the published style's grey text on a palette-coloured map.
   */
  it("gives an id-ambiguous label layer text colour, not a road rule", () => {
    const { map, painted } = fakeMap(STYLE.layers);
    applyMapTheme(map);
    for (const id of ["highway-name-path", "highway-name-minor", "highway-name-major"]) {
      expect(painted.get(id)?.["text-color"], id).toBe("#173353");
    }
  });

  it("still lets a water label keep the water rule's green text", () => {
    const { map, painted } = fakeMap(STYLE.layers);
    applyMapTheme(map);
    expect(painted.get("water_name_point_label")?.["text-color"]).toBe("#40979d");
  });
});

/**
 * The no-flicker path: rewrite the style document before MapLibre ever draws it.
 *
 * Repainting a live map leaves the published colours on screen for a frame or two, so every load
 * flashed grey-blue before settling. These assert the document itself comes out themed.
 */
describe("themeStyle", () => {
  it("rewrites every layer the live repaint would have", () => {
    const style = JSON.parse(JSON.stringify(STYLE)) as { layers: { id: string; type: string }[] };
    expect(themeStyle(style).painted).toBe(STYLE.layers.length);
  });

  it("writes the colours into layer.paint", () => {
    const style = {
      layers: [
        { id: "background", type: "background" },
        { id: "water", type: "fill" },
        { id: "label_town", type: "symbol" },
      ],
    };
    const { style: themed } = themeStyle(style);
    expect(themed.layers?.[0]?.paint?.["background-color"]).toBe(MAP_BACKGROUND);
    expect(themed.layers?.[1]?.paint?.["fill-color"]).toBe("#bfd9db");
    expect(themed.layers?.[2]?.paint?.["text-color"]).toBe("#173353");
  });

  it("keeps published paint properties it does not set", () => {
    // Widths and zoom expressions are what make the style legible. Replacing the whole paint object
    // rather than merging into it would flatten all of that.
    const style = {
      layers: [{ id: "road_minor", type: "line", paint: { "line-width": 3, "line-blur": 0.5 } }],
    };
    const { style: themed } = themeStyle(style);
    expect(themed.layers?.[0]?.paint).toEqual({
      "line-width": 3,
      "line-blur": 0.5,
      "line-color": "#fffdfa",
    });
  });

  it("tolerates a style with no layers", () => {
    expect(themeStyle({}).painted).toBe(0);
  });
});
