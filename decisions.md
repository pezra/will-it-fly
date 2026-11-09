# Decisions

Architectural decisions that would be costly to reverse. Newest first.

## Condition labels are derived in the scorer, apart from the call and the score (2026-11-09, `condition-labels`)

**Decision.** `evaluateHour` outputs the condition labels (Soar, XC, Sledder) as a field on each hour result, and windows summarize them. The labels don't change an hour's call, its score or the list order. The XC label uses the thermal test at any site, while the XC bonus and reason still need a site curated `xc`.
**Motivation.** The UI is not allowed to re-derive scoring thresholds, and the labels needed facts (ungated XC) that no reason carries. Keeping the call and score untouched means a display change can't reorder sites.
**Rejected.**
- Emitting a new reason kind for the labels. Reasons drive caution counts and the no-window reason, and the severity would be new.
- Applying the XC bonus to every site. It would reorder lists and ignore RMHPA's own site descriptions.
- Deriving labels in the UI from reason kinds. It can't see the ungated XC fact and would duplicate rules across layers.

## Weather is fetched only for sites in drive range

**Decision.** The page works out which sites are in range before it asks Open-Meteo for anything: find the start point, drop sites farther than 80 mph × the chosen hours in a straight line, route the rest with OSRM, then fetch weather for the sites within the drive time. With no start point nothing is fetched. A link to a site's page fetches just that site and doesn't wait for the location.

**Motivation.** The first version fetched every site's weather and hid the far ones afterwards. That is wasted traffic and it grows with the catalog, which is expected to get much bigger. The 80 mph prefilter is a bound, not an estimate (no road trip is faster), so it can't drop a site that is really in range. The 40 mph estimate is only the displayed time and the fallback when OSRM is down.

**Rejected.**
- Filter after the forecast. Changing the radius never refetched, but every site was fetched on every visit.
- Prefilter at the 40 mph estimate. It would drop sites that highways make reachable.
- Showing every site when there is no start point. Doesn't scale with the catalog.

## Weather is cached per site

**Decision.** Raw Open-Meteo responses are cached per site, under one `localStorage` key (`will-it-fly/forecast-v2`), each entry with its own fetch time. At most 30 entries are kept, least recently used first, day entries before main ones, and never an entry the current load used. A load fetches only the sites with no fresh entry. The old one-blob `forecast-v1` entries are removed.

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
