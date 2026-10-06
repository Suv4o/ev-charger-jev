/**
 * Open Charge Map POI types.
 *
 * ── Derived from live responses, not from the spec ──────────────────────────────────────────
 *
 * There is a third-party OpenAPI profile for this API and it is a useful map, but it is not what
 * the server actually sends. Two differences were found by reading a real response:
 *
 *   - The spec's example licence is CC BY-SA 4.0. The live Australian data is **CC BY 4.0**.
 *   - Optional fields are present-and-`null`, not absent. `UsageCost`, `Town`, `Distance` and most
 *     of `OperatorInfo` all arrive as explicit nulls.
 *
 * So everything optional here is typed `| null` rather than `?`. That is deliberate: `?` would let
 * `"UsageCost" in poi` pass on a record whose cost is null, which is the check you actually want to
 * get right when the whole point of the project is reading the text fields.
 *
 * ── These types describe the wire, not our domain ───────────────────────────────────────────
 *
 * Nothing outside `src/lib/ocm/` should import these. The client narrows a POI into a `Charger`
 * (see `charger.ts`), and the rest of the app only ever sees that. A wire type leaking into the UI
 * is how you end up with `poi.AddressInfo?.Latitude ?? 0` in a component.
 */

export interface OcmCountry {
  readonly ISOCode: string | null;
  readonly ContinentCode: string | null;
  readonly ID: number;
  readonly Title: string | null;
}

export interface OcmAddressInfo {
  readonly ID: number;
  readonly Title: string | null;
  readonly AddressLine1: string | null;
  readonly AddressLine2: string | null;
  readonly Town: string | null;
  readonly StateOrProvince: string | null;
  readonly Postcode: string | null;
  readonly CountryID: number | null;
  readonly Country: OcmCountry | null;
  readonly Latitude: number | null;
  readonly Longitude: number | null;
  readonly ContactTelephone1: string | null;
  readonly ContactTelephone2: string | null;
  readonly ContactEmail: string | null;
  /** Free text. How you actually reach the bay. 99% distinct across Australian records. */
  readonly AccessComments: string | null;
  readonly RelatedURL: string | null;
  /** Populated ONLY when the query supplied latitude/longitude. Null otherwise. */
  readonly Distance: number | null;
  readonly DistanceUnit: number | null;
}

export interface OcmConnectionType {
  readonly FormalName: string | null;
  readonly IsDiscontinued: boolean | null;
  readonly IsObsolete: boolean | null;
  readonly ID: number;
  readonly Title: string | null;
}

export interface OcmStatusType {
  readonly IsOperational: boolean | null;
  readonly IsUserSelectable: boolean | null;
  readonly ID: number;
  readonly Title: string | null;
}

export interface OcmSupplyType {
  readonly ID: number;
  readonly Title: string | null;
  readonly Description: string | null;
}

export interface OcmConnection {
  readonly ID: number;
  readonly ConnectionTypeID: number | null;
  readonly ConnectionType: OcmConnectionType | null;
  readonly StatusTypeID: number | null;
  readonly StatusType: OcmStatusType | null;
  readonly Amps: number | null;
  readonly Voltage: number | null;
  /** Peak kW for this connection. Present on 97.7% of Australian records. */
  readonly PowerKW: number | null;
  readonly CurrentTypeID: number | null;
  readonly CurrentType: OcmSupplyType | null;
  readonly Quantity: number | null;
  readonly Comments: string | null;
}

export interface OcmUsageType {
  readonly IsPayAtLocation: boolean | null;
  readonly IsMembershipRequired: boolean | null;
  readonly IsAccessKeyRequired: boolean | null;
  readonly ID: number;
  readonly Title: string | null;
}

export interface OcmOperatorInfo {
  readonly WebsiteURL: string | null;
  readonly Comments: string | null;
  readonly PhonePrimaryContact: string | null;
  readonly IsPrivateIndividual: boolean | null;
  readonly BookingURL: string | null;
  readonly ContactEmail: string | null;
  readonly ID: number;
  readonly Title: string | null;
}

export interface OcmDataProvider {
  readonly WebsiteURL: string | null;
  readonly IsOpenDataLicensed: boolean | null;
  /** Per-provider licence string. Australian data is CC BY 4.0 on 1,366 of 1,367 records. */
  readonly License: string | null;
  readonly ID: number;
  readonly Title: string | null;
}

export interface OcmUserComment {
  readonly ID: number;
  readonly Comment: string | null;
  readonly Rating: number | null;
  readonly DateCreated: string | null;
}

export interface OcmPoi {
  readonly ID: number;
  readonly UUID: string;
  readonly DataProvider: OcmDataProvider | null;
  readonly OperatorInfo: OcmOperatorInfo | null;
  readonly UsageType: OcmUsageType | null;
  readonly StatusType: OcmStatusType | null;
  readonly AddressInfo: OcmAddressInfo | null;
  readonly Connections: readonly OcmConnection[] | null;
  readonly UserComments: readonly OcmUserComment[] | null;
  readonly NumberOfPoints: number | null;
  /** Free text. 27.8% of Australian records. */
  readonly GeneralComments: string | null;
  /** Free text, 347 distinct spellings across 926 Australian records. Never parse this in code. */
  readonly UsageCost: string | null;
  readonly IsRecentlyVerified: boolean | null;
  readonly DateLastVerified: string | null;
  readonly DateLastStatusUpdate: string | null;
}
