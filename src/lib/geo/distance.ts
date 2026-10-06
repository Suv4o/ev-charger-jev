import type { Charger, Position } from "../ocm/charger.ts";

/**
 * Every number in this project is computed here, and nothing in this file knows that Jev exists.
 *
 * ── Why this is a separate module with no model import ──────────────────────────────────────
 *
 * The documented limits of a System One model are that it cannot count, cannot do arithmetic and
 * reads dates as text rather than as ordered quantities. That is not a reason to be careful when
 * asking it about numbers — it is a reason never to ask. So the arithmetic lives in one module that
 * imports nothing from the model layer, and the boundary is visible in the import graph rather than
 * held in someone's memory.
 *
 * A test asserts that this file never imports from `../jev/`.
 *
 * ── Why haversine and not a routing API ─────────────────────────────────────────────────────
 *
 * Great-circle distance is not driving distance. A charger 4km away across a river may be a 20km
 * drive. A real product would call a routing service; this one does not, because a free routing API
 * with Australian coverage is another dependency and another key, and the demo's argument does not
 * turn on road distance being exact.
 *
 * The honest consequence, stated rather than buried: **every distance here is a lower bound.** The
 * UI says "straight-line", and the shortlist's safety margin exists partly to absorb it.
 */

/** Mean Earth radius, IUGG. */
const EARTH_RADIUS_KM = 6371.0088;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(from: Position, to: Position): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLon = toRadians(to.lon - from.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * How far the car can still go, in kilometres.
 *
 * `derate` is the gap between a manufacturer's range figure and a real one: highway speed, cold
 * battery, climate control, a roof box. 0.8 is deliberately pessimistic. Running out of charge is a
 * much worse error than stopping earlier than strictly necessary, so the asymmetry is on purpose.
 */
export function remainingRangeKm(
  batteryPercent: number,
  fullRangeKm: number,
  derate = 0.8,
): number {
  const clamped = Math.max(0, Math.min(100, batteryPercent));
  return (clamped / 100) * fullRangeKm * derate;
}

export interface Leg {
  /** Straight-line km from where the driver is now. */
  readonly fromOriginKm: number;
  /** Straight-line km from the charger to the destination. */
  readonly toDestinationKm: number;
  /** Extra km versus driving straight there. Never negative. */
  readonly detourKm: number;
}

/**
 * Distances for one charger against one journey.
 *
 * `detourKm` is clamped at zero. Straight-line geometry can make a charger that is almost exactly
 * on the route come out microscopically negative, and a UI reading "-0.02km out of your way" reads
 * as a bug rather than as a charger on the route.
 */
export function legFor(charger: Charger, origin: Position, destination: Position): Leg {
  const fromOriginKm = haversineKm(origin, charger.position);
  const toDestinationKm = haversineKm(charger.position, destination);
  const direct = haversineKm(origin, destination);
  return {
    fromOriginKm,
    toDestinationKm,
    detourKm: Math.max(0, fromOriginKm + toDestinationKm - direct),
  };
}

/**
 * Can the car reach this charger at all?
 *
 * `reserve` is the fraction of remaining range held back so the driver does not arrive on zero.
 * 0.15 means the charger must be within 85% of what the battery can currently do.
 */
export function isReachable(leg: Leg, rangeKm: number, reserve = 0.15): boolean {
  return leg.fromOriginKm <= rangeKm * (1 - reserve);
}

/** Round for display. Distances are approximate; showing six decimals implies they are not. */
export function displayKm(km: number): number {
  return km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
}

/**
 * Roughly how long you would have to sit there, in minutes.
 *
 * Arithmetic, and therefore code's job — but the shortlist was only using power as a filter, which
 * ranked an 11kW socket above a 250kW Supercharger for a driver who needed to cover 64km. Power is
 * a number we hold exactly; not using it in the ordering was leaving arithmetic on the table and
 * hoping the judgement layer would cover for it. It should not have to.
 *
 * Deliberately crude, and the crudeness is the honest part:
 *
 *   - **No charge curve.** Real DC charging tapers hard above ~60% state of charge, so this
 *     understates the time for a big top-up. It is fine for "enough to get there", which is the
 *     only question being asked.
 *   - **No AC/DC distinction beyond kW.** A 22kW AC figure may be limited by the car's onboard
 *     charger to 7kW. We do not know the car.
 *
 * Returns `null` when the power is unknown, rather than guessing. An unknown is not a zero.
 */
export function minutesToReach(
  distanceToDestinationKm: number,
  usableRangeKm: number,
  powerKw: number | null,
  kwhPerKm = 0.18,
  reserveKm = 15,
): number | null {
  if (powerKw === null || powerKw <= 0) return null;
  const shortfallKm = Math.max(0, distanceToDestinationKm + reserveKm - usableRangeKm);
  if (shortfallKm === 0) return 0;
  return (shortfallKm * kwhPerKm * 60) / powerKw;
}
