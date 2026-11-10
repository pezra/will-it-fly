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
  forecast/          Open-Meteo client and parser, per-site forecast cache
  scoring/           SCORING_DEFAULTS, derived values, hour evaluator,
                     model agreement, window finder
  recommendation/    per-launch evaluation, ranking, getRecommendations
  travel/            straight-line prefilter, drive times (OSRM, with estimates), place search,
                     which sites are in range
  time.ts            America/Denver calendar helpers
src/ui/              Preact components, location, storage, debug params
sites.json           the curated site catalog
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

`npm run dev` serves the app at http://localhost:5173/. The hash picks the page: `#/` and `#/site/<id>` are the default day, and `#/day/YYYY-MM-DD` and `#/day/YYYY-MM-DD/site/<id>` are that day. Every hash ends in `?model=ecmwf` or `?model=rrfs`, the primary forecast model. One with no model, or a bad one, is rewritten in place (no history entry) to the saved default, which is ECMWF until someone uses the model control. Only the control saves the default; opening a link with a model never does. Dev builds honor a few query parameters for checking states by hand. Production builds ignore them.

| Parameter | Effect |
|---|---|
| `?now=2026-11-08T18:30:00-07:00` | fixes the clock (after sunset shows tomorrow). The picker's range follows it |
| `?routeBase=https://invalid.example` | points at a dead OSRM host. Drive times fall back to the "≈" estimates |
| `?lat=39.74&lon=-104.99` | fakes a location |
| `?nolocation` | behaves as if location were denied |
| `?base=https://invalid.example` | points at a dead Open-Meteo host. Combined with a `now` more than an hour after the last fetch, it shows the offline fallback |

The service worker only registers in production builds. To try it, run `npm run build && npm run preview`, load the page twice, stop the server and reload.

## Order of work

The UI loads things in this order, and each step narrows what the next one asks for:

1. The location (or the place the user chose). With no start point nothing else loads.
2. `withinReach`: sites farther than 80 mph times the chosen hours in a straight line are dropped.
3. OSRM drive times for the sites left. Only the sites with no time for this start are asked for, so narrowing the radius asks for nothing and widening asks for the new sites only.
4. Weather, only for the sites within the drive time. A site's detail page loads just its own site at once, without waiting for 1 to 3.

Only the in-range sites' launch coordinates go to Open-Meteo, and the rounded start point goes only to OSRM. Forecasts are cached per site in `will-it-fly/forecast-v2` in localStorage, keeping the 30 most recently used sites (about 2 MB). Each entry has its own fetch time, so a changed radius fetches only the sites with no fresh entry. The old `forecast-v1` entries are deleted when the cache is created. The radius choices are 1 to 4 h; there is no unlimited option.

## Scoring

The rules are in `src/core/scoring/hourEvaluator.ts`, and every threshold and weight is in `SCORING_DEFAULTS` (`src/core/scoring/defaults.ts`). The flow for each launch is:

1. `evaluateHour` gives each hour, for each model, a call (good, flyable, no-go or no data), a score and reasons.
2. `applyStormLookahead` marks the hours before a convective no-go.
3. `findBestWindow` picks the best run of daylight hours, weighted by how well the check model agrees.
4. The ranker picks each site's best launch and orders the sites.

**Any change to `SCORING_DEFAULTS` or to a rule must update the "How sites are scored" section of the README in the same commit.** That section is how a pilot sanity-checks a call, so it has to match the code exactly. A test pins every default, so a changed value fails until the test is updated too.

## Site data

Sites live in `sites.json`, curated by hand from the [RMHPA site pages](https://www.rmhpa.org/flying-sites) and the Pawnee Playground Google My Map that [pawneeparagliding.com](https://pawneeparagliding.com/) redirects to. `parseSites` validates the file when it loads, and `test/core/sites/sitesData.test.ts` checks it for plausible values.

Each site has an `id` (`<source>/<slug>`, where the source is `rmhpa` or `pawnee`), `name`, `sourceURL`, `rating`, `status` (`{"state": "open"}` or `{"state": "closed", "reason": "..."}`), site-level PG `limits` in mph (`minMph`, `idealMph`, `maxMph`, `gustFactorMph`), optional `notes`, and `launches`. Each launch has an `id` (`<site id>/<slug>`), `name`, `coordinate`, `elevationFt`, `directions` and optional `limits` that replace the site's.

`directions` holds `ok` and `ideal` lists of arcs, `{"from": 250, "to": 310}` in degrees clockwise. An arc can wrap through north (`{"from": 337.5, "to": 135}`). An empty `ok` means the direction isn't curated, and the launch is then always flyable at best. An empty `ideal` means anywhere in `ok` counts as ideal.

The `*Source` fields (`elevationSource`, `limitsSource`, `directionsSource`) and `landingZones` are notes for curators, and the app ignores them.

How to read a site guide and turn it into these fields is in the `add-sites` skill, `.agents/skills/add-sites/SKILL.md`.

## Open-Meteo fixtures

`test/fixtures/openmeteo-launches.json` and `openmeteo-neighbors.json` are real responses for three launches: Glenwood Lookout North, Crested Butte and Boulder Wonderland Upper. Next to each one, the `.url.txt` file holds the exact URL it came from. `buildersMatchRecordedURLs` checks that the client still builds those URLs, so a change to the request fails until the fixtures are re-recorded:

```sh
curl -s "$(cat test/fixtures/openmeteo-launches.url.txt)" > test/fixtures/openmeteo-launches.json
curl -s "$(cat test/fixtures/openmeteo-neighbors.url.txt)" > test/fixtures/openmeteo-neighbors.json
```

(Update the `.url.txt` files from the new builder output first.) Some tests assert values from the recorded day, so expect to update those too.

## Adding a site provider

Sites come through the `SiteProvider` interface in `src/core/sites/siteProvider.ts`, which is a single `sites(): Promise<Site[]>`. A new source, e.g. ParaglidingEarth, maps its data into the same `Site` type, and scoring and the UI need no changes. Merging two providers (and deduplicating sites that appear in both) would take a small composite provider that doesn't exist yet.

## README.md

Only discuss the current state of the applicaiton in README.md. No history lessons or future wishes (execpt potentially safely related caveats). Focus on usage and confidence building information about how the app decides which sites are flyable.
