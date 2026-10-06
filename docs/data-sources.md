# Charger data sources — what was checked, and what was chosen

Every claim here was verified by calling the thing, not by reading about it. Date: 26th September 2026.

## The two routes that were proposed, and why both are dead

### Tesla — cannot list Australian Superchargers

The official Fleet API has `nearby_charging_sites`, but it is a **vehicle** endpoint: it returns sites
near one car you own. It needs a registered developer app, OAuth against a real Tesla owner account,
and an actual vehicle on software 2018.48+. There is no way to ask it "chargers near Geelong".

Tesla's only openly published location feed covers NEVI-funded sites, which is a United States
regulatory obligation and excludes Australia entirely.

**Verdict: no free Tesla API for Australian Supercharger locations.**

### Chargefox — fleet customers only

Their own getting-started page: *"If you are a Chargefox fleet customer interested in using the API,
speak to one of our team members or reach out via fleetsupport@chargefox.com."* A Fleets API and an
OCPI CPO API exist, both behind a commercial agreement. No free public tier, no self-serve signup.

**Verdict: ruled out.**

## What was tested and works

### Open Charge Map — CHOSEN

- Free API key, self-serve registration. Non-profit, running since 2011, ~300k charge points.
- `GET https://api.openchargemap.io/v3/poi`, key as `?key=` or `X-API-Key` header.
- Confirmed live: returns `403 "You must specify an API key"` without one, so the endpoint is up.
- Covers every Australian network, not just Tesla.
- **Data licence: CC BY 4.0. Attribution is required** and must be carried in the UI.
  (The OpenAPI spec shows CC BY-SA 4.0 in an *example* value; the live Australian data is CC BY 4.0.
  Verified against 1,367 records — see `ocm-coverage.md`.)

Chosen for one reason above all: it is the only source carrying **unstructured human text** next to
the numbers. See "Why this one" below.

### supercharge.info — works, not chosen

No API key at all. `GET https://supercharge.info/service/supercharge/allSites` returned:

```
11,107 sites worldwide
   193 in Australia — 157 OPEN, 18 PERMIT, 9 CLOSED_PERM, 5 PLAN, 2 CONSTRUCTION
   NSW 81 · Vic 53 · Qld 30 · WA 14 · SA 9 · ACT 3 · Tas 2 · NT 1
```

Per site: GPS, `stallCount`, `powerKilowatt`, `plugs` (AU sites are `ccs2`, not NACS), `status`,
`dateOpened`, `elevationMeters`, `solarCanopy`, `otherEVs`.

Excellent data. Not chosen because it is an **undocumented endpoint** powering their own website,
with no published terms, licence or rate limits — not something to build a published demo on. Also
Tesla-only, and every field is a clean number, which leaves nothing for a decision model to judge.

### OpenStreetMap via Overpass — works, not chosen

No key. Needs a real `User-Agent` or it returns `406`. Query for `amenity=charging_station` within
15km of Melbourne CBD returned **123 nodes**. Coverage is real but quality is patchy: 96/123 had an
`operator`, 62 a `capacity`, and only **16 had a name**. Operators include entries like
"Museums Victoria".

Good enough as a cross-check, too inconsistent to drive the demo.

## Why Open Charge Map, specifically

The project's argument is that code should do the arithmetic and the model should do the judgement.
That argument needs a data source containing both kinds of material. OCM is the only one that does.

**What code handles — arithmetic and filtering, never the model:**

| field | why it is code's job |
| --- | --- |
| `AddressInfo.Latitude` / `Longitude` | distance maths |
| `AddressInfo.Distance` / `DistanceUnit` | OCM computes distance itself when given a lat/long |
| `Connections[].PowerKW`, `Amps`, `Voltage` | is it fast enough for the remaining range |
| `Connections[].Quantity`, `NumberOfPoints` | how many stalls — counting |
| `StatusTypeID` | operational or not |
| `UsageType.IsMembershipRequired`, `IsPayAtLocation` | booleans, not opinions |

**What Jev judges — free text no filter can turn into a decision:**

| field | example content |
| --- | --- |
| `AddressInfo.AccessComments` | how to actually get to the bay, gate codes, height limits |
| `GeneralComments` | e.g. "This is an open charge unit installed at the Coneygear Centre" |
| `UsageCost` | free text, e.g. "See network operators app for current charges" |
| `UserComments[]` | driver reports, with `includecomments=true` |
| `OperatorInfo.Title`, `UsageType.Title` | e.g. "Public - Membership Required" |

That split is the whole demo. A `WHERE power_kw > 50` clause is trivial; deciding whether
*"rear of the shopping centre, follow signs to loading dock, gate locked after 6pm"* suits a driver
with a child in the car at 9pm is not, and it is not generation either.

## Request parameters confirmed from the OpenAPI spec

`output` `client` `maxresults` `countrycode` `countryid` `latitude` `longitude` `distance`
`distanceunit` `operatorid` `connectiontypeid` `levelid` `usagetypeid` `statustypeid`
`dataproviderid` `opendata` `includecomments` `verbose` `compact` `camelcase` `chargepointid`
`boundingbox` `polygon` `polyline` `sortby` `modifiedsince` `greaterthanid`

Two worth noting:

- **`polyline`** searches along a route rather than around a point. The obvious upgrade once the
  point-radius version works.
- **`verbose=false&compact=true`** drops the expanded objects and returns only reference IDs, which
  is much smaller. `verbose=true` is needed for `OperatorInfo`, `UsageType` and `StatusType` titles.

Spec source: the third-party OpenAPI profile at `api-evangelist/openchargemap`. Treat as a strong
hint, not gospel — **every field must be confirmed against a live response** once a key exists.

## Map

**MapLibre GL JS + OpenFreeMap tiles.** No registration, no API key, no request limits, commercial
use explicitly permitted, attribution handled automatically by MapLibre. Styles: Positron, Bright,
Liberty, Dark, Fiord3D.

Required attribution if not using MapLibre's automatic handling:
`OpenFreeMap © OpenMapTiles Data from OpenStreetMap`.

## Still unverified

- Australian coverage numbers in OCM. The endpoint needs a key and none exists yet, so the count of
  Australian POIs and how many carry non-empty `AccessComments` / `GeneralComments` is **unknown**.
  This is the first thing to measure — the demo's argument depends on that text actually being there.
- OCM rate limits. Documented as existing; the numbers were not found.
