import {
  DEFAULT_DESTINATION,
  DEFAULT_ORIGIN,
  isInAustralia,
  placeById,
  PLACES,
} from "../../../src/lib/geo/places.ts";
import { billedCostUsd, createJevClient } from "../../../src/lib/jev/client.ts";
import {
  buildQuestions,
  buildState,
  daylightFor,
  parseTimeOfDay,
} from "../../../src/lib/jev/questions.ts";
import { fetchChargers, OCM_ATTRIBUTION } from "../../../src/lib/ocm/client.ts";
import { buildPlan, derivedFactsFor, shortlist } from "../../../src/lib/plan/plan.ts";

/**
 * One request: chargers in, plan out.
 *
 * Nothing raw crosses this boundary. The client receives `PlannedStop`s carrying a verdict and a
 * sentence — never a score, a probability or a confidence. `plan.test.ts` asserts that by
 * serialising a plan and checking those words are absent.
 */

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2_048;
const SHORTLIST_MAX = 8;

interface PlanRequest {
  readonly said?: string;
  /** A preset id from PLACES, or raw coordinates. Preset wins when both are sent. */
  readonly originId?: string;
  readonly destinationId?: string;
  readonly origin?: { lat?: number; lon?: number };
  readonly destination?: { lat?: number; lon?: number };
  readonly batteryPercent?: number;
  readonly fullRangeKm?: number;
  /** "21:30". Preferred. */
  readonly arriveAt?: string;
  /** Whole hour, kept for the experiment scripts. */
  readonly hour?: number;
}

/**
 * Resolve a location, preferring a preset id and falling back to coordinates.
 *
 * Out-of-Australia coordinates fall back to the default rather than erroring. The dataset is
 * Australian, so a request for Berlin would search an empty region and the reader would reasonably
 * conclude the app is broken rather than that they asked for somewhere with no data in it.
 */
function resolvePlace(
  id: string | undefined,
  raw: { lat?: number; lon?: number } | undefined,
  fallbackId: string,
): { position: { lat: number; lon: number }; name: string } {
  const preset = placeById(id);
  if (preset !== null) return { position: preset.position, name: preset.name };

  if (typeof raw?.lat === "number" && typeof raw?.lon === "number") {
    const candidate = { lat: raw.lat, lon: raw.lon };
    if (Number.isFinite(candidate.lat) && Number.isFinite(candidate.lon) && isInAustralia(candidate)) {
      return { position: candidate, name: `${candidate.lat.toFixed(3)}, ${candidate.lon.toFixed(3)}` };
    }
  }

  const fallback = placeById(fallbackId);
  if (fallback === null) throw new Error(`Default place "${fallbackId}" is missing from PLACES.`);
  return { position: fallback.position, name: fallback.name };
}

/** Exposed so the UI can build its dropdowns from the same list the server validates against. */
export async function GET(): Promise<Response> {
  return Response.json({
    places: PLACES.map((p) => ({ id: p.id, name: p.name, state: p.state })),
    defaults: { originId: DEFAULT_ORIGIN, destinationId: DEFAULT_DESTINATION },
  });
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Request too large." }, { status: 413 });
  }

  let body: PlanRequest;
  try {
    body = JSON.parse(raw) as PlanRequest;
  } catch {
    return Response.json({ error: "Body was not JSON." }, { status: 400 });
  }

  const said = typeof body.said === "string" ? body.said.slice(0, 500).trim() : "";
  if (said === "") {
    return Response.json({ error: "Say what you need." }, { status: 400 });
  }

  const from = resolvePlace(body.originId, body.origin, DEFAULT_ORIGIN);
  const to = resolvePlace(body.destinationId, body.destination, DEFAULT_DESTINATION);
  const origin = from.position;
  const destination = to.position;
  const batteryPercent = clampNumber(body.batteryPercent, 1, 100, 12);
  const fullRangeKm = clampNumber(body.fullRangeKm, 100, 900, 500);
  // Minutes since midnight. A real time field sends "21:30"; the experiment scripts still send a
  // whole hour, and a missing value means now.
  const now = new Date();
  const arriveMinutes =
    (typeof body.arriveAt === "string" ? parseTimeOfDay(body.arriveAt) : null) ??
    (typeof body.hour === "number" && Number.isFinite(body.hour)
      ? Math.round(clampNumber(body.hour, 0, 23, 0)) * 60
      : now.getHours() * 60 + now.getMinutes());

  const source = await fetchChargers({
    origin,
    destination,
    maxResults: 600,
  });

  const picked = shortlist(source.chargers, {
    origin,
    destination,
    batteryPercent,
    fullRangeKm,
    max: SHORTLIST_MAX,
  });

  const common = {
    origin,
    destination,
    originName: from.name,
    destinationName: to.name,
    arriveAt: `${String(Math.floor(arriveMinutes / 60)).padStart(2, "0")}:${String(arriveMinutes % 60).padStart(2, "0")}`,
    rangeKm: Math.round(picked.rangeKm),
    considered: source.chargers.length,
    eliminated: picked.eliminated,
    live: source.live,
    fallbackReason: source.fallbackReason,
    attribution: OCM_ATTRIBUTION,
  };

  if (picked.shortlist.length === 0) {
    return Response.json({
      ...common,
      stops: [],
      priority: null,
      note: "Nothing within reach on that battery. Nothing to ask the model.",
      latencyMs: 0,
      billedUsd: 0,
    });
  }

  const arriving = daylightFor(arriveMinutes);

  try {
    const client = createJevClient();
    const now = Date.now();
    // The same arithmetic the interface shows, phrased for the model. One derivation, not two.
    const derived = derivedFactsFor(picked.shortlist, picked.legs, picked.rangeKm, now);
    const startedAt = performance.now();
    const result = (await client.systemOne({
      state: buildState(said, picked.shortlist, arriving, derived),
      questions: buildQuestions(picked.shortlist),
    })) as {
      answers: Record<string, { score?: number; noul?: number; choice?: string }>;
      usage: { input_tokens: number };
    };
    const latencyMs = Math.round(performance.now() - startedAt);

    const plan = buildPlan(picked.shortlist, picked.legs, result.answers, {
      afterDark: arriving === "after dark",
      filteredByCode: picked.eliminated,
      rangeKm: picked.rangeKm,
      now,
    });

    return Response.json({
      ...common,
      // The Charger carries wire-ish detail the UI does not need. Send only what is rendered.
      stops: plan.stops.map((stop) => ({
        id: stop.charger.id,
        name: stop.charger.name,
        town: stop.charger.town,
        operator: stop.charger.facts.operator,
        position: stop.charger.position,
        verdict: stop.verdict,
        reason: stop.reason,
        evidence: stop.evidence,
        costBand: stop.costBand,
        detourKm: stop.detourKm,
        maxPowerKw: stop.maxPowerKw,
        minutesToReach: stop.minutesToReach,
        membershipRequired: stop.charger.facts.membershipRequired,
        freshness: stop.freshness,
        freshnessLabel: stop.freshnessLabel,
        driverReports: stop.driverReports,
        hero: stop.hero,
      })),
      priority: plan.priority,
      arriving,
      questionsAsked: Object.keys(buildQuestions(picked.shortlist)).length,
      inputTokens: result.usage.input_tokens,
      latencyMs,
      billedUsd: billedCostUsd(result),
    });
  } catch (error) {
    return Response.json(
      {
        ...common,
        stops: [],
        priority: null,
        error: error instanceof Error ? error.message : "The model could not be reached.",
      },
      { status: 502 },
    );
  }
}
