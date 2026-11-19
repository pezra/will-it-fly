# Decisions

Architectural decisions that would be costly to reverse. Newest first.

## Forecasts are fetched per site point, and each model only for what it's read for (2026-11-18, `cheaper-forecast-requests`)

A site's launches share the forecast for its highest launch. Only a launch more than 1,000 ft below that gets its own forecast. Each site has one neighbor ring. Surface and pressure-level variables go in separate requests, so each model is asked only for what is read from it. A full load had cost about 560 of Open-Meteo's 600 weighted calls a minute per IP, most of it on duplicate points and model/variable pairs nobody read. Elevation is the one input that changes the forecast between a site's launches.

### Rejected
- Our own lapse-rate correction for lower launches. It's a scoring rule built on a guess at Open-Meteo's downscaling.
- Deduplicating only identical launch points. That leaves 47 points instead of 37.

## Failed forecast loads are retried once, only for network failures (2026-11-18, `improve-forecast-fetch-reliability`)

A load that fails on a timeout or network error is retried once, after the page is visible again if it was hidden. HTTP errors aren't retried, and a 429 holds Retry and Refresh for 90 s. Requests give up after 5 s without headers, 20 s for the body. iOS freezes requests in a hidden page, and a full load costs about 560 of Open-Meteo's 600 weighted calls a minute per IP, so extra loads have to be rare.

### Rejected
- Restarting an in-flight load on resume: a second full load even when the first would land.
- One request per site: the same quota cost, and Open-Meteo's HTTP/1.1 queues them behind six connections.
- A flat 5 s timeout: a slow connection can't download a full response in 5 s.

## Errors go to Sentry, with nothing personal in them (2026-11-17, `error-tracking`)

Production builds on a real host report uncaught errors, render crashes, failed recommendations loads, and failed Open-Meteo, OSRM and Nominatim requests to Sentry, through `@sentry/browser` bundled from npm and started before the first render. Default integrations are off, so nothing records breadcrumbs or wraps `fetch`, and `dataCollection` keeps out user info, cookies, page queries and headers other than User-Agent. Failed requests are reported from the one fetch transport in `src/ui`, through a listener hook so neither the transport nor `src/core` imports the SDK. A failed request is described by its host, the leading words of its path (OSRM puts the start point in the path), and the error's name or HTTP status, which together group it. It also carries context that tells failures apart when the browser hides the reason: the stage it failed at, timing, whether the page was hidden during it (iOS kills backgrounded requests), connection type, earlier successes, URL length rounded to 100, and the error message with every word holding a digit or `/ ? = & : @` redacted, since URL-shaped text is where coordinates and search text would be. Redacting by that word rule fails safe for messages no one has seen yet, where matching URL patterns missed uppercase schemes and bare coordinates (updated 2026-11-17, `api-failure-detail`). Each host and kind is sent once per page load, nothing is sent offline, and a page load sends at most 25 events, which keeps an outage inside the free quota. Source maps are public, since the source is.

The app had no way to learn it was broken for someone. The privacy limits follow from what the app already promises in the README: the start point and search text never leave the device except to the services that need them. Sentry's server stores the request IP unless the project's "Prevent Storing of IP Addresses" setting is on, so that setting is part of this decision.

### Rejected
- GlitchTip, Bugsnag, Rollbar or Honeybadger. Similar free tiers, and Sentry is the usual choice for browser JS. GlitchTip takes the same SDK, so it stays a drop-in option.
- Sentry's CDN loader. It's third-party code loaded at runtime, and it can miss errors from the first render.
- Uploading private source maps from CI. It needs a token in GitHub secrets to hide source that's already public.
- Reporting from inside `src/core`. Core can't import UI or SDK code, and the transport already sees every request.
- Reporting the `console.warn` recoveries too. They're mostly the same network failures the transport already reports.
- Sending errors to GoatCounter as events. Counts only, no stack, and usage analytics and error tracking are kept apart.

## Usage is counted with GoatCounter, with no identifier sent (2026-11-17, `usage-analytics`)

The app reports page views and events straight to GoatCounter's `/count` endpoint (`sendBeacon`, image fallback), only from a production build on `pezra.github.io`. Pages are normalized to `/`, `/kite` and `/site/<id>`, and events are path-style names from one typed union (`mode/kite`, `drive/fly/3h`). Weekly and monthly unique devices come from markers in `willItFly.usage.v1`: the device remembers the last Denver day, ISO week and month it was counted, and sends `active/day|week|month` on the first open of each.

The app is a static site with no logs, so counting needs a hosted service that handles hash routes and custom events. Without a stored ID GoatCounter can't link visits across days, and the markers fix that without sending one. Paths and event names are the keys of the collected history, so renaming them splits it. Allowing one host keeps dev, LAN previews and forks out of the counts.

### Rejected
- Cloudflare Web Analytics. No hash-route support, no custom events, and it reports visits, not unique visitors.
- `count.js`. Third-party code in the page for what one request does.
- A random device ID sent with each hit. It's an identifier, and the markers give the same counts.
- Blocking only localhost. Forks and LAN previews of a production build would count as real use.

## The briefing prompt holds only the guide's site facts (2026-11-16, `27-ai-flight-briefing`)

The conditions briefing hands a site-day to Claude or ChatGPT with a prompt built only from the `Site` and the day, so the app's call and the start point never reach it. Facts are given as the guide states them: curated ideal arcs, uncurated directions marked as such, and placeholder limits flagged, which is the one bit of `limitsSource` that `parseSites` keeps (`limitsDefaulted`). The point is an independent second opinion, and an agent shown our verdict or made-up limits judges against them.

### Rejected
- Including the app's verdict for the agent to check. It anchors the agent.
- Detecting placeholder limits by comparing with `DEFAULT_WIND_LIMITS`. A guide can publish the same numbers.

## Sites have a kind, and Kite mode is in the list URL (2026-11-11, `14-kiting-sites`)

A site in `sites.json` is `"kind": "flying"` (the default) or `"kiting"`, and its kind decides how it is scored, wherever it is shown. Kiting parks are scored on surface wind and gusts only, with the gust rules in `SCORING_DEFAULTS`. The mode only chooses which kind a list shows. Kite lists are `#/kite` and `#/kite/<date>`, and site pages have no mode in their URL, because the site's kind gives it. Nothing saves the mode on the device. The weather load is keyed by the list's mode like the model, and a site page loads with no mode. Kite has its own radius (`kiteMinutes`) in `willItFly.travel.v1`.

A site page has no mode in its URL, so if the mode decided the rules a park could be scored as a flying site. A link should open in the mode it names, but a fresh open should be Fly, so the mode lives in the URL and not on the device. Keying the load by mode keeps one mode's list from showing under the other. Leaving the site page's load unkeyed keeps it from restarting when the catalog arrives.

### Rejected
- A separate kiting catalog. It needs a second provider and the composite provider that doesn't exist yet, and a site would have two shapes.
- The mode deciding the rules. A site page has no mode, so a park could get flying calls.
- The mode in the query string or saved on the device. A device default would make the home screen icon open in Kite after one use.
- Keeping the other mode's result on screen during a switch. Filtered by kind, it showed as an empty list.

## The primary model is a per-request choice, evaluated by role (2026-11-09, `primary-model-switch`)

The request names a primary model (ECMWF or RRFS). Each launch is evaluated with that model deciding and the other as the cross-check, and every result past the hour evaluator (daylight rows, windows, agreement, confidence) is shaped by role, not by model name. With RRFS asked for, a launch falls back to ECMWF for the whole day when RRFS covers less than 75% of the day's window hours.

RRFS is better in some places but stops about 3½ days out. It is a straight swap of roles, so one set of rules serves both models. Role-named fields make the compiler find every reader that assumed ECMWF decides. A whole-day fallback keeps a window's hours and its agreement on one model. The threshold is 75% rather than half, because RRFS usually ends late morning on day +3, which is about half a November day, and keeping RRFS then hides afternoon windows.

### Rejected
- Model-named rows plus a "which is primary" key. Any reader that forgot the key would quietly keep showing ECMWF.
- Falling back hour by hour. Windows and agreement would mix models.
- One generic "other model sees storms" reason kind. A kind has fixed text and severity, and two kinds cost one line each.

## The model choice is in the URL, with a device default only the control writes (2026-11-09, `primary-model-switch`)

Every app URL carries `?model=` in the hash, and a URL without one is rewritten in place to a default saved on the device (`willItFly.model.v1`). Only the model control writes that default. The model is part of the weather load key, so a switch re-evaluates from the cached forecast, which holds both models, and shows loading rather than the old model's result.

A shared link, Back and a reload must keep the model, and the home screen icon has no model in its URL. Unlike the start point, the model isn't private, so the URL is fine for it. Opening someone else's link shouldn't change what your app opens with.

### Rejected
- Model only in the URL. The home screen icon would always open on the built-in default.
- Model only on the device. Links couldn't share it and Back couldn't undo a switch.
- Any URL with a model updating the default. A friend's link would change your default.
- Keeping the previous result on screen during a switch. It would briefly label one model's calls as the other's.

## Condition labels are derived in the scorer, apart from the call and the score (2026-11-09, `condition-labels`)

`evaluateHour` outputs the condition labels (Soar, XC, Sledder) as a field on each hour result, and windows summarize them. The labels don't change an hour's call, its score or the list order. The XC label uses the thermal test at any site, while the XC bonus and reason still need a site curated `xc`.

The UI is not allowed to re-derive scoring thresholds, and the labels needed facts (ungated XC) that no reason carries. Keeping the call and score untouched means a display change can't reorder sites.

### Rejected
- Emitting a new reason kind for the labels. Reasons drive caution counts and the no-window reason, and the severity would be new.
- Applying the XC bonus to every site. It would reorder lists and ignore RMHPA's own site descriptions.
- Deriving labels in the UI from reason kinds. It can't see the ungated XC fact and would duplicate rules across layers.

## Weather is fetched only for sites in drive range

The page works out which sites are in range before it asks Open-Meteo for anything: find the start point, drop sites farther than 80 mph × the chosen hours in a straight line, route the rest with OSRM, then fetch weather for the sites within the drive time. With no start point nothing is fetched. A link to a site's page fetches just that site and doesn't wait for the location.

The first version fetched every site's weather and hid the far ones afterwards. That is wasted traffic and it grows with the catalog, which is expected to get much bigger. The 80 mph prefilter is a bound, not an estimate (no road trip is faster), so it can't drop a site that is really in range. The 40 mph estimate is only the displayed time and the fallback when OSRM is down.

### Rejected
- Filter after the forecast. Changing the radius never refetched, but every site was fetched on every visit.
- Prefilter at the 40 mph estimate. It would drop sites that highways make reachable.
- Showing every site when there is no start point. Doesn't scale with the catalog.

## Weather is cached per site

**Decision.** Raw Open-Meteo responses are cached per site, under one `localStorage` key (`will-it-fly/forecast-v3`), each entry with its own fetch time. At most 30 entries are kept, least recently used first, day entries before main ones, and never an entry the current load used. A load fetches only the sites with no fresh entry. The old one-blob `forecast-v1` entries are removed, and so are the `forecast-v2` entries from before forecasts were fetched per site point (updated 2026-11-18, `cheaper-forecast-requests`).

**Motivation.** The one-blob cache only worked for the exact same list of launches, so any change of radius or start point missed it and refetched everything. Per-site entries let a widened radius fetch only the new sites and a narrowed one fetch nothing.

**Rejected.**
- A cache per set of sites. Simplest, but a different radius is a different set, so it misses every time.
- One `localStorage` key per site. Cheaper writes, but eviction needs an index that can disagree with the entries. The tradeoff is rewriting about 2 MB per save (tracked in an issue).

## Drive times come from OSRM, with a straight-line fallback

**Decision.** Drive times come from one OSRM `table` request per start point, using the public demo server, with the start rounded to 0.01° (about 1 km) before it leaves the device. If OSRM fails or can't route a site, that site gets straight-line miles at 40 mph, shown with "≈". Place search uses Nominatim, only when the user presses Search.

**Motivation.** Mountain roads make straight-line distance wrong by 2× for sites like Aspen and Crested Butte. OSRM costs one request per start however many sites there are, and the estimate means an outage degrades the numbers, not the app.

**Rejected.**
- Straight-line estimates only.
- Open-Meteo geocoding. It knows towns, not addresses.
- Self-hosted routing. It needs a backend this app doesn't have. The OSRM base URL is one constant, so we can move later.

## The start point and radius are stored on the device, not in the URL

**Decision.** The start point and drive time are kept in `localStorage` (`willItFly.travel.v1`). They never go in the URL hash.

**Motivation.** A shareable URL would leak someone's home location into every link they send.

**Rejected.** Putting them in the URL hash.

## Get weather forecasts from Open-Meteo

Use Open-Meteo for all weather forecast data, with ECMWF and RRFS as the two models.

### Motivation

Windy's point forecast API doesn't include ECMWF because of licensing, and ECMWF is needed as the check model and for days past RRFS's range. Open-Meteo is free for non-commercial use and has the models we need. HRRR on Open-Meteo is discontinued at the end of November 2026, and RRFS is NOAA's replacement, so use RRFS.

### Rejected
- Using Windy.com with HRRR as primary and some other weak model for cross checks.
- using different APIs for different models.
