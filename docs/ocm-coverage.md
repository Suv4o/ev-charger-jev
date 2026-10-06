# Open Charge Map — measured Australian coverage

Measured 26th September 2026 against the live API with a real key.
One call: `countrycode=AU&maxresults=2000&verbose=true&includecomments=true`.

**1,367 Australian POIs returned** in 2.8s, 7.5MB.

## The numbers code will use — effectively complete

| field | coverage |
| --- | ---: |
| `AddressInfo.Latitude` / `Longitude` | **100.0%** |
| `NumberOfPoints` | 99.6% |
| `UsageType.Title` | 99.9% |
| `OperatorInfo.Title` | 98.9% |
| `Connections[].PowerKW` | 97.7% |

Distance, power, stall count and operator are all reliably present. Every filter and every
calculation in the demo can be done in code with no gaps to paper over.

## The text Jev will judge — present, and genuinely unstructured

| field | coverage | distinct |
| --- | ---: | ---: |
| `UsageCost` | 67.7% | 347 of 926 |
| `GeneralComments` | 27.8% | 84% unique |
| `AccessComments` | 15.9% | **99% unique** (215 of 217) |
| `UserComments[]` | 10.2% | — |
| **at least one of the four** | **76.5%** | |

`AccessComments` being 99% distinct is the important one: it is hand-written per site, not a network
boilerplate string repeated across a fleet.

## The finding that decides the demo

**91 Australian sites (6.7%) carry a time or duration constraint that exists in no structured field
at all.** It is written in prose, in `AccessComments` or `GeneralComments`, and nothing in the schema
captures it. Real examples:

- `Only powered during cafe business hours`
- `open 10am to 4pm We have coffee and a lovely Garden to enjoy whle you charge.`
- `Evening peak 68c kWh (5:00pm to 10:00pm) Standard 59c kWh (all other times)`
- `Monday to Thursday 5:00am - 12:30am Friday & weekends 5:00am - 2:00am`
- `Please adhere to entry and exit signs into driveway during working hours and days 5am-5pm Monday to Friday`
- `Idle fee grace period (min): 15; Idle fee per minute: $0.50`
- `24/7 - drive next to Police Station`

No `WHERE` clause reaches that. A driver arriving at 9pm at "only powered during cafe business hours"
finds a dead charger, and every structured field on that record says it is fine.

## Price is free text in at least five incompatible formats

926 sites quote a cost, in 347 distinct spellings:

```
Free · FREE · $0.45 per kWh · 55c/kWh · $0.30/kWh
AUD 0.42/kWh;other tariffs for older cars
$0.40 per kWh. Parking overstay charges may apply
```

Worth being precise about what to do with this, because it is the easiest thing to get wrong:

> **Do not ask a model to parse this into a number.** That is generation, it is the thing Jev cannot
> do, and it is the thing an LLM would do unreliably. Ask instead for a judgement over a closed set —
> free / cheap / typical / expensive / conditional — which is a Choice, and is exactly what a
> System One model is for. The arithmetic that follows stays in code.

## Other access material

`AccessComments` samples, all of which affect whether a stop is usable and none of which are fields:

- `Type 2 point only no cable on site` — bring your own cable or you are not charging
- `Enter university, first left into car park, back row of parking`
- `Southern end of the undercover car park`
- `Same location as Tas Petroleum`
- `Carpark 4`

## Operators present

| operator | sites |
| --- | ---: |
| Chargefox | 321 |
| (Unknown Operator) | 221 |
| Evie | 196 |
| (Business Owner at Location) | 103 |
| Tesla (Tesla-only charging) | 77 |
| NRMA | 66 |
| Tesla (including non-tesla) | 64 |
| Queensland Electric Super Highway | 41 |
| BP Pulse (AU) | 39 |
| Exploren | 32 |

Note: **Chargefox is the largest operator in the set, at 321 sites.** Their own API is closed to
anyone without a fleet agreement, and their locations are in Open Charge Map anyway. The closed API
turned out not to matter.

## Usage restrictions

| usage type | sites |
| --- | ---: |
| Public - Membership Required | 809 |
| Public | 387 |
| Private - For Staff, Visitors or Customers | 74 |
| Public - Pay At Location | 55 |
| Privately Owned - Notice Required | 15 |
| Private - Restricted Access | 14 |
| Public - Notice Required | 7 |

59% require a membership. Structured, so code handles it — but whether a given driver *minds* is a
judgement.

## Licence

Measured across the 1,367 records, not read off the spec — the spec's *example* value says
CC BY-SA 4.0 and the live Australian data does not:

| provider | sites | licence |
| --- | ---: | --- |
| Open Charge Map Contributors | 1,366 | **Creative Commons Attribution 4.0 International (CC BY 4.0)** |
| CarStations.com | 1 | `None` |

So: **CC BY 4.0**, attribution required in the UI, no share-alike obligation. `DataProvider.License`
carries it per record and `DataProvider.IsOpenDataLicensed` flags it, so the one record without a
licence can be filtered rather than assumed.

## One API behaviour worth knowing

`AddressInfo.Distance` is `null` unless the query supplies `latitude` and `longitude`. With them, OCM
computes the distance for you in the requested `distanceunit`. Do not rely on it being present.
