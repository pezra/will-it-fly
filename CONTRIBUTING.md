# Contributing

## Setup

You need Node 24. With nvm:

```sh
nvm use
npm ci
```

## Layout

```
src/core/            all logic, with no DOM or browser globals
  sites/             site types, arcs, coordinates
  forecast/          Open-Meteo client and parser, forecast cache
  scoring/           SCORING_DEFAULTS, derived values, hour evaluator,
                     model agreement, window finder
  recommendation/    per-launch evaluation, ranking, getRecommendations
  time.ts            America/Denver calendar helpers
src/ui/              Preact components, location, storage, debug params
sites.json           the curated RMHPA site catalog
public/              manifest, icons, service worker template
test/                Vitest tests, mirroring src/core
scripts/             make-icons.mjs
```

`src/core` talks to the outside world only through what it's given: a `Transport` for HTTP, a `KeyValueStore` for the cache, and a `now` function. It's type-checked with `tsconfig.core.json`, which has no DOM types, and `test/coreBoundary.test.ts` fails if it imports `preact` or anything from `src/ui`. Keep it that way, so the logic stays testable in Node.

Times in `src/core` are epoch milliseconds. All calendar logic (days, hours, labels) goes through `src/core/time.ts`, which is pinned to America/Denver. Don't use `Date`'s local-time getters.

## Testing

```sh
npm test                     # Vitest, once
TZ=UTC npm test              # catches code that leans on the machine's time zone
TZ=Asia/Kolkata npm test     # and +5:30 catches what UTC hides
npm run check                # tsc for the app, the DOM-free core and vite.config.ts
npm run build                # production build into dist/
```

Tests read fixture files with Vite's `?raw` import rather than `node:fs`.

## Running it

`npm run dev` serves the app at http://localhost:5173/. The hash picks the page: `#/` and `#/site/<id>` are the default day, and `#/day/YYYY-MM-DD` and `#/day/YYYY-MM-DD/site/<id>` are that day. Dev builds honor a few query parameters for checking states by hand. Production builds ignore them.

| Parameter | Effect |
|---|---|
| `?now=2026-11-08T18:30:00-07:00` | fixes the clock (after sunset shows tomorrow). The picker's range follows it |
| `?lat=39.74&lon=-104.99` | fakes a location |
| `?nolocation` | behaves as if location were denied |
| `?base=https://invalid.example` | points at a dead Open-Meteo host. Combined with a `now` more than an hour after the last fetch, it shows the offline fallback |

The service worker only registers in production builds. To try it, run `npm run build && npm run preview`, load the page twice, stop the server and reload.

## Scoring

The rules are in `src/core/scoring/hourEvaluator.ts`, and every threshold and weight is in `SCORING_DEFAULTS` (`src/core/scoring/defaults.ts`). The flow for each launch is:

1. `evaluateHour` gives each hour, for each model, a call (good, flyable, no-go or no data), a score and reasons.
2. `applyStormLookahead` marks the hours before a convective no-go.
3. `findBestWindow` picks the best run of daylight hours, weighted by RRFS agreement.
4. The ranker picks each site's best launch and orders the sites.

**Any change to `SCORING_DEFAULTS` or to a rule must update the "How sites are scored" section of the README in the same commit.** That section is how a pilot sanity-checks a call, so it has to match the code exactly. A test pins every default, so a changed value fails until the test is updated too.

## Site data

Sites live in `sites.json`, curated by hand from the [RMHPA site pages](https://www.rmhpa.org/flying-sites). `parseSites` validates the file when it loads, and `test/core/sites/rmhpaSitesData.test.ts` checks it for plausible values.

Each site has an `id` (`rmhpa/<slug>`), `name`, `sourceURL`, `rating`, `status` (`{"state": "open"}` or `{"state": "closed", "reason": "..."}`), site-level PG `limits` in mph (`minMph`, `idealMph`, `maxMph`, `gustFactorMph`), optional `notes`, and `launches`. Each launch has an `id` (`<site id>/<slug>`), `name`, `coordinate`, `elevationFt`, `directions` and optional `limits` that replace the site's.

`directions` holds `ok` and `ideal` lists of arcs, `{"from": 250, "to": 310}` in degrees clockwise. An arc can wrap through north (`{"from": 337.5, "to": 135}`). When a page doesn't give both ranges:

1. Explicit OK and ideal ranges are used as written.
2. With only an ideal range, or a stated facing ("west facing"), the launch faces the middle of the ideal range (or the stated facing) and `ok` is facing ±45°.
3. With no direction information, `ok` is empty. The launch is then always flyable at best ("launch direction not curated") until someone fills it in.

A missing elevation comes from the Open-Meteo elevation API, `https://api.open-meteo.com/v1/elevation?latitude=..&longitude=..`, converted from metres to feet and recorded with `"elevationSource": "open-meteo"`. Missing PG limits use the default (0 / 15 mph, gust factor 5) with `"limitsSource": "default"`. The `*Source` fields and `landingZones` are notes for curators, and the app ignores them. Put any judgment call in the site's `notes` so the next curator can see it.

## Open-Meteo fixtures

`test/fixtures/openmeteo-launches.json` and `openmeteo-neighbors.json` are real responses for three launches: Glenwood Lookout North, Crested Butte and Boulder Wonderland Upper. Next to each one, the `.url.txt` file holds the exact URL it came from. `buildersMatchRecordedURLs` checks that the client still builds those URLs, so a change to the request fails until the fixtures are re-recorded:

```sh
curl -s "$(cat test/fixtures/openmeteo-launches.url.txt)" > test/fixtures/openmeteo-launches.json
curl -s "$(cat test/fixtures/openmeteo-neighbors.url.txt)" > test/fixtures/openmeteo-neighbors.json
```

(Update the `.url.txt` files from the new builder output first.) Some tests assert values from the recorded day, so expect to update those too.

## Adding a site provider

Sites come through the `SiteProvider` interface in `src/core/sites/siteProvider.ts`, which is a single `sites(): Promise<Site[]>`. A new source, e.g. ParaglidingEarth, maps its data into the same `Site` type, and scoring and the UI need no changes. Merging two providers (and deduplicating sites that appear in both) would take a small composite provider that doesn't exist yet.

## Why not HRRR or Windy

HRRR on Open-Meteo is discontinued at the end of November 2026, and RRFS is NOAA's replacement. Windy's point forecast API doesn't include ECMWF because of licensing, and ECMWF is the model this app trusts most.
