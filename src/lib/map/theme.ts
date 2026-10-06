/**
 * Recolour the basemap to the app's palette.
 *
 * ── Why this is done at runtime and not by forking the style ─────────────────────────────────
 *
 * OpenFreeMap's `liberty` style has 111 layers. Forking 43KB of style JSON to change a dozen colours
 * would mean maintaining a copy that silently stops matching upstream, and the diff would be almost
 * entirely noise.
 *
 * So the style loads as published and every layer is repainted once on load. The rules match on layer
 * id and type rather than on an exact list, because the ids follow a clear scheme
 * (`road_*_casing`, `waterway_*`, `landcover_*`, `bridge_*`) and matching the scheme survives upstream
 * adding another road class.
 *
 * ── Order matters ───────────────────────────────────────────────────────────────────────────
 *
 * `waterway_tunnel` contains both "water" and "tunnel". The rules are tested in order and the first
 * match wins, so water comes before roads.
 *
 * ── Why every call is wrapped ───────────────────────────────────────────────────────────────
 *
 * A layer's paint property may not exist, and MapLibre throws rather than ignoring it. One unexpected
 * layer type should tint the map imperfectly, never leave the reader with a blank page.
 *
 * ── Two entry points, and the first one is the important one ─────────────────────────────────
 *
 * `themeStyle` rewrites a style **document** before the map is constructed. `applyMapTheme` repaints a
 * **live** map.
 *
 * The live version alone is not good enough: MapLibre renders the published colours as soon as the
 * style resolves, and the repaint lands a frame or two later, so every load flashed grey-blue before
 * settling into the palette. Fetching the style, rewriting it, and handing MapLibre the finished
 * object means the first painted frame is already correct.
 *
 * `applyMapTheme` is kept for a style that changes after construction, and as the fallback when the
 * style fetch fails and MapLibre is given the URL instead.
 */

const P = {
  primary: "#ee5f53",
  primaryLight: "#f1918b",
  blue: "#295a92",
  secondary: "#173353",
  secondaryLight: "#37506e",
  greenBlue: "#bfd9db",
  green: "#40979d",
  beige: "#d8d7c1",
  beigeLight: "#efe8df",
  beigeGray: "#9b9b9b",
  gray: "#6d6e71",
  graySecondary: "#74869b",
  paper: "#fffdfa",
} as const;

interface Rule {
  /** First match wins. */
  readonly test: (id: string, type: string) => boolean;
  readonly fill?: string;
  readonly outline?: string;
  readonly line?: string;
  readonly text?: string;
  readonly halo?: string;
  readonly opacity?: number;
}

const has = (id: string, ...needles: string[]): boolean =>
  needles.some((n) => id.toLowerCase().includes(n));

const RULES: readonly Rule[] = [
  // Water first: `waterway_tunnel` would otherwise be caught by the tunnel rule.
  {
    test: (id) => has(id, "water"),
    fill: P.greenBlue,
    line: P.greenBlue,
    outline: P.green,
    text: P.green,
    halo: P.beigeLight,
  },

  // Green space, a shade off the ground so parks read without shouting.
  { test: (id) => has(id, "park", "landcover_wood", "landcover_grass", "pitch", "cemetery"), fill: "#d5ddc9", outline: "#c3cdb4" },
  { test: (id) => has(id, "landcover_sand", "landcover_ice", "landcover_wetland"), fill: "#e7e3d2" },
  { test: (id) => has(id, "landuse_residential", "landuse"), fill: "#eae4d8" },

  // Buildings: visible at zoom, never competing with the route.
  { test: (id) => has(id, "building"), fill: P.beige, outline: "#c9c8b0" },

  // Roads. A casing is the dark edge drawn under the fill, so it wants the darker colour.
  { test: (id) => has(id, "casing"), line: "#ddd8c8" },
  { test: (id) => has(id, "motorway", "trunk"), line: "#f7e9cf" },
  { test: (id) => has(id, "primary", "secondary", "tertiary"), line: P.paper },
  { test: (id) => has(id, "road", "street", "bridge", "tunnel", "link", "service", "track", "path", "pedestrian"), line: P.paper },

  // Rail, kept faint. It is context, not content.
  { test: (id) => has(id, "rail", "transit", "ferry", "aeroway"), line: P.beigeGray, opacity: 0.45 },

  // Borders.
  { test: (id) => has(id, "boundary"), line: P.graySecondary, opacity: 0.4 },

  // Labels. Navy on a beige halo, matching the sidebar text rather than the basemap's own grey.
  { test: (_id, type) => type === "symbol", text: P.secondary, halo: P.beigeLight },

  // Anything left over.
  { test: (_id, type) => type === "fill", fill: "#eae4d8" },
  { test: (_id, type) => type === "line", line: "#ddd8c8" },
];

/** Minimal shape of the MapLibre map we need, so this module does not import the library. */
export interface ThemeableMap {
  getStyle: () => { layers?: readonly { id: string; type: string }[] } | undefined;
  setPaintProperty: (layer: string, property: string, value: unknown) => void;
}

export const MAP_BACKGROUND = P.beigeLight;

interface StyleLayer {
  id: string;
  type: string;
  paint?: Record<string, unknown>;
}

export interface StyleDocument {
  layers?: StyleLayer[];
  [key: string]: unknown;
}

/**
 * The paint properties one layer should end up with. The single source of truth for both entry
 * points, so a live repaint and a pre-render rewrite can never disagree.
 */
function paintFor(id: string, type: string): Record<string, unknown> | null {
  if (type === "background") return { "background-color": P.beigeLight, "background-opacity": 1 };
  // Hillshade or similar. Dropped: it is grey, and it muddies every colour underneath it.
  if (type === "raster") return { "raster-opacity": 0 };
  if (type === "fill-extrusion") return { "fill-extrusion-color": P.beige };

  // Match on the property the layer actually needs, not merely on the id.
  //
  // Matching on the id alone was subtly wrong and a count test caught it. `highway-name-path` is a
  // SYMBOL layer whose id contains "path", so it matched the road rule — which only defines a line
  // colour — and came away with nothing. Seven label layers were silently keeping the published
  // style's grey text on a palette-coloured map.
  //
  // Picking the first rule that matches *and* defines the relevant property means `water_name_label`
  // still gets the water rule's green text, while `highway-name-path` falls through to the generic
  // symbol rule.
  const key = type === "fill" ? "fill" : type === "line" ? "line" : type === "symbol" ? "text" : null;
  if (key === null) return null;
  const rule = RULES.find((r) => r.test(id, type) && r[key] !== undefined);
  if (rule === undefined) return null;

  const out: Record<string, unknown> = {};
  if (type === "fill") {
    out["fill-color"] = rule.fill;
    if (rule.outline !== undefined) out["fill-outline-color"] = rule.outline;
    if (rule.opacity !== undefined) out["fill-opacity"] = rule.opacity;
  } else if (type === "line") {
    out["line-color"] = rule.line;
    if (rule.opacity !== undefined) out["line-opacity"] = rule.opacity;
  } else {
    out["text-color"] = rule.text;
    if (rule.halo !== undefined) {
      out["text-halo-color"] = rule.halo;
      out["text-halo-width"] = 1.6;
    }
  }
  return out;
}

/**
 * Rewrite a style document in place and return it, ready to hand to `new Map({ style })`.
 *
 * This is the no-flicker path: the first frame MapLibre paints is already the palette. Returns how
 * many layers were rewritten, for the same reason `applyMapTheme` does.
 */
export function themeStyle(style: StyleDocument): { style: StyleDocument; painted: number } {
  let painted = 0;
  for (const layer of style.layers ?? []) {
    const paint = paintFor(layer.id, layer.type);
    if (paint === null) continue;
    // Merged over the published paint, so properties we do not set (widths, dash arrays, the zoom
    // expressions that make the style legible) survive untouched.
    layer.paint = { ...(layer.paint ?? {}), ...paint };
    painted += 1;
  }
  return { style, painted };
}

/**
 * Repaint every layer. Safe to call more than once; safe to call on a style that has changed.
 *
 * Returns how many layers were touched, which is the only cheap way to notice that an upstream style
 * rename has quietly turned the theming into a no-op.
 */
export function applyMapTheme(map: ThemeableMap): number {
  const layers = map.getStyle()?.layers ?? [];
  let painted = 0;

  for (const layer of layers) {
    const paint = paintFor(layer.id, layer.type);
    if (paint === null) continue;
    for (const [property, value] of Object.entries(paint)) {
      try {
        map.setPaintProperty(layer.id, property, value);
      } catch {
        // This layer does not have that property. Expected, and not worth a log line per layer.
      }
    }
    painted += 1;
  }

  return painted;
}
