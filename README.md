# Will it fly?

Ranks the nearby paragliding sites (just RMHPA so far) by how flyable they look today. Each site is evaluated for safey (no-go call), XC/Soaring potential, its best time window, how much the models agree. Flyable sites are labeled Soar, XC or Sledder, with any cautions listed beside the labels.

[Try it!](https://pezra.github.io/will-it-fly)

It's a static web app meant for a phone. Open it in Safari and use Share → Add to Home Screen to get an app-like icon that also opens offline with the last forecast.

**This is a decision aid, not a go/no-go authority.** Forecasts are wrong regularly and site data goes stale. Check the conditions at launch, read the site guide and make your own call.

## Usage

The list shows the sites within a drive time of your start point, in this order:

1. Sites with a flyable window show in their best window, best window score first.
2. Open sites without a window, nearest first, with the main reason.
3. Closed sites.

Flyable sites show condition labels (Soar, XC or Sledder). A caution line in amber lists any cautions in the best window. See [Condition labels](#condition-labels).

The start point and drive time are set in the bar under the day picker. It starts at 2 h from your location. Tap it to choose 1, 2, 3 or 4 h. You can also search for a town or address and start from there, and "Use my location" switches back to your location once a place is chosen. Start point and drive time are remembered on this device.

The same bar has a Forecast model choice, ECMWF or RRFS. The one you pick makes the call for every site, and the other checks it. The bar's summary line shows which is in use, for example "Within 2 h of Boulder · RRFS". The choice is in the link, so a link you share, Back and a reload all keep it, and your last choice is remembered on this device. RRFS only runs about 3½ days ahead, so with RRFS chosen the days beyond that use ECMWF, and the list and the site page say so.

When sites are hidden, the list says how many (for example "3 sites hidden (over 2 h away)"). Widen the drive time to see them. Without a start point the list is empty and asks you to set one, since there is nothing to measure from.

Tap a site to see its launches, the hour by hour conditions from both models (the one making the call first), and the reasons for each hour's call. Refresh fetches a new forecast, unless the last one is under 5 minutes old. Each site's forecast is reused for an hour, and the age shown is that of the oldest one on screen.

If you allow location access, the drive times and distances are measured from where you are. Without it everything still works, but you must manually specify a start point.

## Data

- Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0), using the free non-commercial tier.
- Drive times are routed by [OSRM](https://project-osrm.org/) and place search uses [Nominatim](https://nominatim.openstreetmap.org/). Both use [OpenStreetMap](https://www.openstreetmap.org/) data (© OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/)). Nominatim's [usage policy](https://operations.osmfoundation.org/policies/nominatim/) applies.
- For drive times, the start point rounded to about 1 km goes to the OSRM server, along with the site coordinates, which are public. The text you type in search goes to Nominatim. The app keeps the drive times for the last five rounded start points on your device.
- Open-Meteo gets the launch coordinates of the sites in drive range, or of the one site whose page you open. It never gets your start point.
- Forecasts are cached on your device per site, for the 30 most recently used sites.
- Your last forecast model choice is saved on your device.
- Site information from [RMHPA](https://www.rmhpa.org/flying-sites), curated by hand into `sites.json`. Each site links to its RMHPA page. Verify before flying.

## How sites are scored

Every number below lives in `SCORING_DEFAULTS` (`src/core/scoring/defaults.ts`).

### Forecasts

Each open launch gets two forecasts from Open-Meteo:

- **ECMWF** (`ecmwf_ifs` for surface fields and boundary layer height, `ecmwf_ifs025` for the 700, 600 and 500 hPa levels). It's the default primary model.
- **RRFS** (`ncep_rrfs_conus`, the 3 km successor to HRRR).

Either model can be the **primary model**, with ECMWF as the default. The primary model's hours decide the calls, scores, reasons and windows. The other is the **check model**, used for model agreement and storm detection. Both are evaluated with the same rules and thresholds; only the roles swap.

RRFS runs only about 3½ days ahead. With RRFS primary, a launch falls back to ECMWF for the day when RRFS covers less than three quarters (0.75) of the day's window hours: daylight, from the current hour if it's today. An hour counts as covered when RRFS has it with wind and precipitation. With no window hours left, RRFS stays primary. A launch never mixes models within a day.

Precipitation is reported for the hour *before* each timestamp, so flying hour h uses the larger of hour h and h+1. Everything else uses hour h.

**Launch wind** is the stronger of the 10 m wind and, for launches above the 700 hPa height, the pressure-level wind interpolated to launch elevation. Model terrain is smoothed, so the 10 m wind reads low at peak launches.

**Wind aloft** is the strongest wind at any pressure level between 600 m above launch and the top of lift. Top of lift is launch elevation plus the larger of the cloud base and the boundary layer height, or launch + 1500 m if both are missing.

### Hour calls

Each hour is **no-go** if any of these hold:

| Rule | Threshold |
|---|---|
| Precipitation (hour h or h+1) | ≥ 0.25 mm |
| Launch wind over the site max | > max |
| Launch wind under the site min | < min, when min > 0 |
| Wind direction outside the launch's OK range | wind ≥ 4 mph (below that, direction is ignored) |
| Over the back aloft | aloft wind ≥ 20 mph from outside the OK range |
| Strong wind aloft | ≥ 35 mph from any direction |
| Inconsistent wind 5 mi away | differs by > 90°, or by > 60° with the neighbor ≥ 10 mph (both ≥ 5 mph) |

These things produce warnings and lower the score:

| Rule | Threshold |
|---|---|
| Storms coming | within 2 h before an hour with a precipitation no-go and CAPE ≥ 200 J/kg |
| Other model sees storms (RRFS sees storms / ECMWF sees storms) | the check model has a precipitation no-go for this hour |
| Overdevelopment risk | CAPE ≥ 500 J/kg |
| Wind aloft | ≥ 25 mph |
| Near max | launch wind within 2 mph of the site max |
| Low cloud | cloud base < 1500 ft above launch, or low cloud cover ≥ 60% |
| Inconsistent wind 5 mi away | differs by > 60° (both ≥ 5 mph) |
| Direction OK but not ideal | inside the OK range, outside the ideal range |
| Direction not curated | the launch has no OK range |

One rule only costs points but doesn't produce a warning:

| Rule | Threshold |
|---|---|
| Sledder | boundary layer < 500 m and thermal index > 0 °C (if one is missing, the other decides) |

Sites with `xc` or `soaring` get a bonus if those look likely to work.

| Bonus | When | Points |
|---|---|---|
| Ridge lift | the site is marked soarable (some sites list only certain launches), the launch wind is in an ideal direction and ≥ 8 mph (a site can override the 8) | +10, and the sledder penalty is waived |
| XC potential | the site is marked XC and thermal index ≤ −3 °C, boundary layer ≥ 2000 m and wind aloft under 25 mph | +5 |

Ridge lift doesn't raise the site's wind max, that's a safety limit.

If a launch has no ideal range, anywhere in its OK range counts as ideal. A single ideal heading (e.g. "Ideal 200") counts as ±15°.

The nearby-wind check compares 10 m winds at the launch's grid point and at points 5 mi N, E, S and W, within one model. It uses RRFS when it can, whichever model is primary, because ECMWF's ~9 km grid barely resolves 5 mi, and falls back to ECMWF.

**Gusts are not scored.** Model gusts on light thermal days often run 10–14 mph over the mean wind, which says little about what you'll find at launch. Instead, an hour shows "⚠ high gusts possible" when the gust factor (each hour's gust minus that hour's 10 m wind, the larger of h and h+1) is at least 3× the site's gust-factor limit. That's 15 mph at the default limit of 5.

### Hour score

No-go hours score 0. Other hours start at 50, then:

| Factor | Points |
|---|---|
| Wind speed | up to +20 at the site's ideal speed (or the middle of min and max), falling linearly to 0 at min and max |
| Wind from an ideal direction | +10 |
| Thermal index (lowest pressure level ≥ 1200 m above launch) | +10 if ≤ −3 °C, +5 if ≤ −1 °C |
| Boundary layer height | +5 if ≥ 1500 m |
| Cloud base | +5 if ≥ 3000 ft above launch |
| Ridge lift (soarable sites) | +10 |
| XC potential (XC sites) | +5 |
| Each flyable-level or sledder reason | −5 |

The score is clamped to 0–100.

- **Cloud base** is (temperature − dewpoint) × 125 m, from 2 m values Open-Meteo adjusts to launch elevation. It runs high at launches well above model terrain, which is why low cloud cover is checked as well and the base is shown as "≈".
- **Thermal index** is the level temperature minus a surface parcel lifted dry adiabatically (9.8 °C/km). Lower means stronger thermals.
- **Boundary layer height** is relative to the model's smoothed terrain, not to launch, so treat it as a rough signal.

### Windows and confidence

A window is a run of consecutive daylight hours (from sunrise, or from the current hour today, until sunset) with no no-go or no-data hours. Its score is:

> mean hour score × run length weight × confidence weight

| Run length | Weight |
|---|---|
| 1 h | 0.6 |
| 2 h | 0.8 |
| 3 h or more | 1.0 |

The check model **agrees** with the primary model for an hour when the check model isn't no-go, the launch wind directions are within 30° (or both are under 4 mph), and the speeds are within 5 mph.

| Confidence | When | Weight |
|---|---|---|
| High | the check model agrees on ≥ 75% of the hours it covers | 1.0 |
| Medium | ≥ 40% | 0.85 |
| Low | < 40% | 0.7 |
| Primary model only ("ECMWF only" or "RRFS only") | the check model covers less than half the window | 0.85 |

Each launch gets its best window, and a site takes its best launch. Ties go to the earlier window and to the launch listed first. A site with no flyable window shows its most common no-go reason.

### Condition labels

Flyable hours get one or more labels, shown as pills. They say what the hour offers. A label doesn't change the call, the score or the order.

- **Soar**: the ridge lift rule applies. The site is marked soarable, the launch wind is in an ideal direction and it is at least 8 mph (a site can override the 8). It needs the `soaring` note.
- **XC**: thermal index ≤ −3 °C, boundary layer ≥ 2000 m and wind aloft under 25 mph. This applies at any site, whether or not it is marked XC.
- **Sledder**: neither Soar nor XC applies.

An hour can have both Soar and XC. Sledder is only the fallback. It is not the sledder penalty above, which uses different thresholds.

A site's pills come from its best window: Soar and XC if any hour in the window has them, otherwise Sledder. So a window with XC hours and Sledder hours shows only XC.

Cautions show on their own amber line, not as pills. Each kind of caution appears once, up to two are shown, and any others are counted as "+N more".

