import type { OcmPoi } from "./types.ts";

/**
 * The domain type, and the whole argument of this project expressed as a type.
 *
 * ── Why `facts` and `prose` are separate objects ────────────────────────────────────────────
 *
 * A Charger is split in two, and the split is load-bearing rather than tidy:
 *
 *   - **`facts`** are numbers and booleans. Code reads them, filters on them, does arithmetic with
 *     them. Jev never sees them, because Jev cannot count, cannot compare magnitudes reliably and
 *     reads dates as text. Handing it `4.2` and expecting a distance judgement is the documented
 *     way to get a wrong answer.
 *
 *   - **`prose`** is free text written by humans. Jev reads it. Code never parses it, because the
 *     926 Australian records quoting a price do so in 347 distinct spellings — `Free`, `FREE`,
 *     `55c/kWh`, `AUD 0.42/kWh;other tariffs for older cars` — and any regex over that is a bug
 *     with a release date.
 *
 * Keeping them in one flat object would make the rule a convention that a tired afternoon breaks.
 * Keeping them apart means the function that builds the model's input can accept `prose` and
 * literally cannot be passed a kilowatt figure.
 *
 * ── The thing this is protecting against ────────────────────────────────────────────────────
 *
 * The tempting shortcut is to ask the model "which of these is closest?" It will answer. It will
 * often be right. It is still wrong to ask, because the answer is arithmetic the caller already has
 * exactly, and a model's approximate agreement with a number you already know is not a feature.
 */

export interface Position {
  readonly lat: number;
  readonly lon: number;
}

/** Numbers and booleans. Code's half. Never reaches the model. */
export interface ChargerFacts {
  /** Peak kW across all connections. Null when no connection reports one (2.3% of records). */
  readonly maxPowerKw: number | null;
  /** Total charging points. */
  readonly connectorCount: number | null;
  /** Distinct connector names, e.g. "CCS (Type 2)", "Type 2 (Socket Only)". */
  readonly connectors: readonly string[];
  readonly operational: boolean;
  readonly membershipRequired: boolean;
  readonly payAtLocation: boolean;
  readonly operator: string | null;
  /** True when OCM has confirmed the record recently. A staleness signal, not a quality one. */
  readonly recentlyVerified: boolean;
  /**
   * ISO timestamp of the last time anyone confirmed this record, or null.
   *
   * Populated on 100% of the Australian set, and the spread is the reason it matters: 75% of records
   * have not been confirmed in over two years. That is the only hard evidence in the whole dataset
   * bearing on whether a charger still works, and turning a date into an age is arithmetic — code's
   * job, never the model's, which reads dates as text.
   */
  readonly lastVerifiedAt: string | null;
}

/**
 * Human-written text. The model's half. Code never parses it.
 *
 * Every field is `string | null` and callers must handle null: 23.5% of Australian records carry
 * none of this at all, and a demo that silently treats "no information" as "no problem" would be
 * making exactly the mistake the project is about.
 */
export interface ChargerProse {
  /** How to reach the bay. 99% distinct across Australian records, so genuinely per-site. */
  readonly access: string | null;
  /** Anything else the contributor wanted to say. */
  readonly general: string | null;
  /** Cost as written. Never a number. */
  readonly cost: string | null;
  /** Driver reports, when the query asked for them. */
  readonly userComments: readonly string[];
}

export interface Charger {
  readonly id: number;
  readonly name: string;
  readonly town: string | null;
  readonly state: string | null;
  readonly position: Position;
  readonly facts: ChargerFacts;
  readonly prose: ChargerProse;
  /** Licence string from the record's data provider. Carried so the UI can attribute correctly. */
  readonly licence: string | null;
}

/** Trim to null. OCM sends `""` and `"  "` as well as `null`, and all three mean "nothing here". */
function text(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Narrow one wire POI into a Charger, or `null` if it cannot be used.
 *
 * Returns null rather than throwing, and rather than substituting defaults. A record with no
 * coordinates cannot be placed on a map or measured against a route, and quietly coercing it to
 * `0, 0` would put a charger in the Atlantic. The caller filters nulls and reports the count.
 */
export function toCharger(poi: OcmPoi): Charger | null {
  const address = poi.AddressInfo;
  if (address === null) return null;

  const { Latitude: lat, Longitude: lon } = address;
  if (lat === null || lon === null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const connections = poi.Connections ?? [];

  // Max, not sum. A site with a 350kW and a 22kW stall can charge at 350kW.
  const powers = connections
    .map((c) => c.PowerKW)
    .filter((kw): kw is number => typeof kw === "number" && Number.isFinite(kw) && kw > 0);
  const maxPowerKw = powers.length > 0 ? Math.max(...powers) : null;

  const connectors = [
    ...new Set(
      connections
        .map((c) => text(c.ConnectionType?.Title ?? null))
        .filter((t): t is string => t !== null && t !== "Not Specified"),
    ),
  ];

  const name = text(address.Title) ?? text(address.AddressLine1) ?? `Charger ${poi.ID}`;

  return {
    id: poi.ID,
    name,
    town: text(address.Town) ?? text(address.AddressLine2),
    state: text(address.StateOrProvince),
    position: { lat, lon },
    facts: {
      maxPowerKw,
      connectorCount: poi.NumberOfPoints,
      connectors,
      // Absent status is treated as NOT operational. The opposite default would have the demo
      // recommending a charger it knows nothing about, which is the failure that matters here.
      operational: poi.StatusType?.IsOperational === true,
      membershipRequired: poi.UsageType?.IsMembershipRequired === true,
      payAtLocation: poi.UsageType?.IsPayAtLocation === true,
      operator: text(poi.OperatorInfo?.Title ?? null),
      recentlyVerified: poi.IsRecentlyVerified === true,
      // Falls back to the status-update date. Both are present on the whole Australian set, and
      // either one is evidence that a human looked at this record on a given day.
      lastVerifiedAt: text(poi.DateLastVerified) ?? text(poi.DateLastStatusUpdate),
    },
    prose: {
      access: text(address.AccessComments),
      general: text(poi.GeneralComments),
      cost: text(poi.UsageCost),
      userComments: (poi.UserComments ?? [])
        .map((c) => text(c.Comment))
        .filter((c): c is string => c !== null),
    },
    licence: text(poi.DataProvider?.License ?? null),
  };
}

/** Narrow a whole response, reporting how many records were unusable rather than hiding it. */
export function toChargers(pois: readonly OcmPoi[]): {
  readonly chargers: readonly Charger[];
  readonly dropped: number;
} {
  const chargers: Charger[] = [];
  let dropped = 0;
  for (const poi of pois) {
    const charger = toCharger(poi);
    if (charger === null) dropped += 1;
    else chargers.push(charger);
  }
  return { chargers, dropped };
}

/** True when there is anything for the model to read. 23.5% of Australian records have nothing. */
export function hasProse(charger: Charger): boolean {
  const { access, general, cost, userComments } = charger.prose;
  return access !== null || general !== null || cost !== null || userComments.length > 0;
}
