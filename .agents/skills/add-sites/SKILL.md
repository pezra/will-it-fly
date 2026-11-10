---
name: add-sites
description: Add flying sites to sites.json from a site guide (club pages, a Google My Map, a PDF). Use to add sites, curate a new source, or fill in a site's directions, elevation, limits or soaring.
---

# Adding sites

`CONTRIBUTING.md` ("Site data") describes the fields. Scripts are in `.agents/skills/add-sites/scripts/` (`$S`). Run Python with `-I` and keep downloads in their own scratch directory.

## Sources

- Fetch every page about a site. Use only the source for directions, limits, ratings and hazards. Pages the source links to for a site count as the source: say which page a fact came from, and note any that couldn't be fetched.
- Look behind the rendered page before falling back to terrain. An edit or source link, a repo, or a KML or JSON export can hold fields the page doesn't show.
- Google My Map: use its KML export, `https://www.google.com/maps/d/kml?mid=<mid>&forcekml=1`, and `$S/kml_summary.py`. KML is longitude first.
- RMHPA (`rmhpa/`): one page per site under https://www.rmhpa.org/flying-sites.
- Pawnee (`pawnee/`): pawneeparagliding.com redirects to a My Map, `mid=1I8Q0FGZfJT_J_VO8GnWyizANwfYgwPu6`. Each folder is a site.
- BHGC (`bhgc/`): one page per region, e.g. https://www.bhgc.org/sites/laketahoe-renoarea/index.html, with `#site_<slug>` anchors. Its data file, https://raw.githubusercontent.com/BHGC/website/master/content/sites/sites.dcf, has `WindDirections` the page doesn't show. `Requirements` are hang gliding ratings. HangGliding.org links block automated fetches.

## Sites

Follow the source's grouping, except:

- Drive time uses a site's first launch. Launches far apart or with separate entrances are separate sites. Put the one nearest parking first.
- `status` is per site, so a launch with its own closure is its own site.
- A site's call comes from its best launch, so a launch with empty `ok` makes the whole site flyable in any wind. Keep uncurated launches out of curated sites.
- Leave out training hills and tow sites.

## Launches

- Ids: `<source>/<slug>`, `<site id>/<slug>`. Coordinates to 4 decimals.
- Names: the site's name only, as the source writes it. Don't add a region, even for a regional guide, since the drive time gives the context.
- Directions:
  1. Explicit ok and ideal ranges as written.
  2. Only an ideal range or a stated facing: `ok` = the facing (or the ideal's middle) ±45°.
  3. Nothing: the terrain facing, checked on the contours, `ok` ±45°, `ideal` ±15°.
  4. Nothing, and no clear slope or a knob that drops off on several sides (`also` in `terrain.py`): ask the author, with `ok` empty until they answer.

  Compass points are 22.5° apart: "best W-WNW" is ideal 270–292.5. "Works NE-E-SE" with no "best" is ok only. "Best with S" is ideal `{180, 180}`. Arcs go the short way. Record the reading in `directionsSource`.
- Elevation, if missing: one call to `https://api.open-meteo.com/v1/elevation?latitude=a,b&longitude=x,y`, m × 3.28084, `"elevationSource": "open-meteo"`. If the source's elevation is over 150 ft from the terrain's (`!` in `terrain.py`), keep the source's and say so in the notes.
- Limits, if missing: `{ "minMph": 0, "maxMph": 15, "gustFactorMph": 5 }`, `"limitsSource": "default"`.
- Rating, `soaring`, `xc`: only from the source or the author. Otherwise `"Unrated"`, and ask. Ratings for other sports (H for hang gliding) go in the notes, and the site stays Unrated. Author's calls go in the notes as "the author's (YYYY-MM-DD)".
- Seasonal closures aren't modeled: keep the site open and lead its notes with the closure.

## Terrain

```sh
python3 -I $S/terrain.py <scratch>/tiles sites sites.json <source>/
python3 -I $S/terrain.py <scratch>/tiles launch <lat> <lon>     # estimates the facing
```

- An estimated facing (`*`) is the biggest drop within 200 m of the pin. It's wrong about one time in four, often because the pin is on the ridgetop, so check it on the contours. `launch` mode prints the drop toward each compass point.
- Its soaring suggestion is a question for the author, never a reason to set `soaring`.
- A face of 100 m or less needs about 10 mph for ridge lift: `idealMph` 12, and if it soars, `"soaring": {..., "minMph": 10}`.
- `$S/otm_stitch.py <lat> <lon> <dir>` shows contours, turbines, power lines and roads.
- Use User-Agent `will-it-fly site curation`. Never send the author's details.

## Writing

Put the new sites in a JSON list, in key order, and run `python3 -I $S/append_sites.py sites.json <new>.json`. It writes them in the file's own formatting, refuses ids already there and sets `curatedOn`.

## Notes

Pilot information first: closures, directions, hazards, access, camping. Then `Curation notes:` with every judgment call, what was derived or left out, and the source. Paraphrase.

## Tests and docs

- `test/core/sites/sitesData.test.ts`: the count and the `closedSites` list. For a new source, `SOURCE_HOSTS` and the `hasCleanIds` regex. Add `arcsContain` checks for arcs that could go the wrong way and for judgment calls.
- New source: the footer in `src/ui/App.tsx`, the README's first line and credit, CONTRIBUTING's source list and id prefix, and "Sources" above.

## Verify

`npx vitest run test/core/sites/sitesData.test.ts` (Node 24 via nvm).

## Report

How launches were grouped, what was left out, every estimate, and every Unrated site. Ask about ratings, soaring and XC with each launch's terrain line, and about any direction left for the author.
