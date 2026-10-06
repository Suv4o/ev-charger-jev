import type { Position } from "../ocm/charger.ts";

/**
 * Preset start and end points.
 *
 * ── Why a list and not a geocoder ───────────────────────────────────────────────────────────
 *
 * Melbourne → Geelong was hardcoded, which made the demo a single fixed query. Free-text locations
 * would need a geocoder: Nominatim is the free option, and it asks for one request per second and a
 * contact address in the User-Agent. That is a second upstream service to degrade gracefully around
 * for a demo whose argument has nothing to do with geocoding.
 *
 * A list also happens to be better for testing. Each entry changes which chargers exist, which is the
 * variable worth moving, and a reader can compare two runs without wondering whether the geocoder
 * resolved their typing the same way twice.
 *
 * Coordinates are city/suburb centres, rounded to four decimals — about 11 metres, far finer than a
 * demo working in straight-line kilometres can justify.
 */

export interface Place {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly position: Position;
}

/**
 * Chosen to span very different charger densities, because that is what changes the behaviour.
 *
 * A CBD gives a dense shortlist where nothing is far away and the judgement does all the work. A
 * regional town gives a sparse one where the arithmetic dominates and "nothing in reach" becomes a
 * real outcome rather than a theoretical one.
 */
export const PLACES: readonly Place[] = [
  { id: "melbourne", name: "Melbourne CBD", state: "Vic", position: { lat: -37.8136, lon: 144.9631 } },
  { id: "geelong", name: "Geelong", state: "Vic", position: { lat: -38.1499, lon: 144.3617 } },
  { id: "ballarat", name: "Ballarat", state: "Vic", position: { lat: -37.5622, lon: 143.8503 } },
  { id: "bendigo", name: "Bendigo", state: "Vic", position: { lat: -36.7570, lon: 144.2794 } },
  { id: "traralgon", name: "Traralgon", state: "Vic", position: { lat: -38.1956, lon: 146.5403 } },
  { id: "sydney", name: "Sydney CBD", state: "NSW", position: { lat: -33.8688, lon: 151.2093 } },
  { id: "wollongong", name: "Wollongong", state: "NSW", position: { lat: -34.4278, lon: 150.8931 } },
  { id: "newcastle", name: "Newcastle", state: "NSW", position: { lat: -32.9283, lon: 151.7817 } },
  { id: "canberra", name: "Canberra", state: "ACT", position: { lat: -35.2802, lon: 149.1310 } },
  { id: "brisbane", name: "Brisbane CBD", state: "Qld", position: { lat: -27.4698, lon: 153.0251 } },
  { id: "goldcoast", name: "Gold Coast", state: "Qld", position: { lat: -28.0167, lon: 153.4000 } },
  { id: "adelaide", name: "Adelaide CBD", state: "SA", position: { lat: -34.9285, lon: 138.6007 } },
  { id: "perth", name: "Perth CBD", state: "WA", position: { lat: -31.9523, lon: 115.8613 } },
  { id: "hobart", name: "Hobart", state: "Tas", position: { lat: -42.8821, lon: 147.3272 } },
];

const BY_ID = new Map(PLACES.map((place) => [place.id, place]));

export function placeById(id: string | undefined): Place | null {
  return id === undefined ? null : BY_ID.get(id) ?? null;
}

export const DEFAULT_ORIGIN = "melbourne";
export const DEFAULT_DESTINATION = "geelong";

/** Australia's bounding box, used to reject a coordinate that would search an empty region. */
export function isInAustralia(position: Position): boolean {
  return (
    position.lat <= -9 &&
    position.lat >= -45 &&
    position.lon >= 112 &&
    position.lon <= 155
  );
}
