import { isInAustralia, placeById } from "../../../src/lib/geo/places.ts";
import { routeThrough } from "../../../src/lib/route/osrm.ts";

/**
 * Draw a route: origin → destination, optionally via one charger.
 *
 * Separate from `/api/plan` on purpose. Clicking a charger to see the detour must not re-ask the
 * model anything — the judgement has not changed, only what the reader wants drawn. Keeping them
 * apart means a click costs nothing and cannot alter a verdict.
 */

export const runtime = "nodejs";

interface RouteRequest {
  readonly originId?: string;
  readonly destinationId?: string;
  readonly via?: { lat?: number; lon?: number };
}

export async function POST(request: Request): Promise<Response> {
  let body: RouteRequest;
  try {
    body = (await request.json()) as RouteRequest;
  } catch {
    return Response.json({ error: "Body was not JSON." }, { status: 400 });
  }

  const origin = placeById(body.originId);
  const destination = placeById(body.destinationId);
  if (origin === null || destination === null) {
    return Response.json({ error: "Unknown start or end." }, { status: 400 });
  }

  const points = [origin.position];
  const via = body.via;
  if (typeof via?.lat === "number" && typeof via?.lon === "number") {
    const point = { lat: via.lat, lon: via.lon };
    if (Number.isFinite(point.lat) && Number.isFinite(point.lon) && isInAustralia(point)) {
      points.push(point);
    }
  }
  points.push(destination.position);

  const route = await routeThrough(points);
  return Response.json(route);
}
