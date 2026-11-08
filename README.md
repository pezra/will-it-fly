# Will it fly?

Ranks the RMHPA paragliding sites by how flyable they look today, using the ECMWF forecast and NOAA's RRFS model as a cross-check. Each site gets a call (good, flyable or no-go), its best time window, how much the two models agree, and the reasons behind the call.

It's a static web app meant for a phone. Open it in Safari and use Share → Add to Home Screen to get an app-like icon that also opens offline with the last forecast.

**This is a decision aid, not a go/no-go authority.** Forecasts are wrong regularly and site data goes stale. Check the conditions at launch, read the site guide and make your own call.

## Usage

The list shows every RMHPA site:

1. Good sites, best window score first.
2. Flyable sites, best window score first.
3. Open sites without a window, nearest first, with the main reason.
4. Closed sites.

Tap a site to see its launches, the hour by hour ECMWF and RRFS conditions, and the reasons for each hour's call. Refresh fetches a new forecast, unless the last one is under 5 minutes old. Forecasts are otherwise reused for an hour.

After local sunset it shows tomorrow instead of today. The Today and Tomorrow buttons, and the date picker, show any day up to 14 days out. A day after tomorrow is fetched on its own when you pick it. RRFS only runs about 3½ days ahead, so windows further out are ECMWF only, and a two-week forecast is a rough guide at best.

If you allow location access you'll see distances. Without it everything still works, and the distances are left out. (To change it on an iPhone: Settings → Safari → Location.)

## Data

- Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0), using the free non-commercial tier.
- Site information from [RMHPA](https://www.rmhpa.org/flying-sites), curated by hand into `sites.json`. Each site links to its RMHPA page. Verify before flying.

## How sites are scored

Every number below lives in `SCORING_DEFAULTS` (`src/core/scoring/defaults.ts`).

### Forecasts

Each open launch gets two forecasts from Open-Meteo:

- **ECMWF** (`ecmwf_ifs` for surface fields and boundary layer height, `ecmwf_ifs025` for the 700, 600 and 500 hPa levels). This drives the call.
- **RRFS** (`ncep_rrfs_conus`, the 3 km successor to HRRR). It's used for model agreement, the nearby-wind check and storm detection.

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

Otherwise it's **flyable** (not good) if any of these hold:

| Rule | Threshold |
|---|---|
| Storms coming | within 2 h before an hour with a precipitation no-go and CAPE ≥ 200 J/kg |
| RRFS sees storms | RRFS has a precipitation no-go for this hour |
| Overdevelopment risk | CAPE ≥ 500 J/kg |
| Wind aloft | ≥ 25 mph |
| Near max | launch wind within 2 mph of the site max |
| Low cloud | cloud base < 1500 ft above launch, or low cloud cover ≥ 60% |
| Inconsistent wind 5 mi away | differs by > 60° (both ≥ 5 mph) |
| Direction OK but not ideal | inside the OK range, outside the ideal range |
| Direction not curated | the launch has no OK range |

Otherwise it's **good**. An hour with no ECMWF wind or precipitation is **no data**, never good.

One rule only costs points and never changes the call:

| Rule | Threshold |
|---|---|
| Sledder | boundary layer < 500 m and thermal index > 0 °C (if one is missing, the other decides) |

It used to cap the hour at flyable. On weak November days at Boulder and Golden it fired all day, even though both were soarable, so now it just lowers the score.

Two bonuses only add points and never change the call. Both depend on notes curated from the RMHPA pages (`soaring` and `xc` in the site JSON), so a site RMHPA doesn't describe that way never gets them:

| Bonus | When | Points |
|---|---|---|
| Ridge lift | the site is marked soarable (some sites list only certain launches), the launch wind is in an ideal direction and ≥ 8 mph (a site can override the 8) | +10, and the sledder penalty is waived |
| XC potential | the site is marked XC, thermal index ≤ −3 °C, boundary layer ≥ 2000 m and wind aloft under 25 mph | +5 |

Ridge lift doesn't raise the site's wind max. RMHPA's limits are safety limits, and its pages advise against high-wind soaring at the mountain sites. Boulder and Golden are not marked soarable, because RMHPA doesn't describe them as ridge sites (Boulder depends on a bubble of east wind, and west wind there is a hazard). Both are marked XC.

If a launch has no ideal range, anywhere in its OK range counts as ideal. A single ideal heading (e.g. "Ideal 200") counts as ±15°.

The nearby-wind check compares 10 m winds at the launch's grid point and at points 5 mi N, E, S and W, within one model. It uses RRFS when it can, because ECMWF's ~9 km grid barely resolves 5 mi, and falls back to ECMWF.

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

RRFS **agrees** with ECMWF for an hour when RRFS isn't no-go, the launch wind directions are within 30° (or both are under 4 mph), and the speeds are within 5 mph.

| Confidence | When | Weight |
|---|---|---|
| High | RRFS agrees on ≥ 75% of the hours it covers | 1.0 |
| Medium | ≥ 40% | 0.85 |
| Low | < 40% | 0.7 |
| ECMWF only | RRFS covers less than half the window | 0.85 |

Each launch gets its best window, and a site takes its best launch. Ties go to the earlier window and to the launch listed first. A site's call is good if its best window has at least one good hour, flyable if the window has only flyable hours, and no-go if it has no window. Good sites always rank above flyable ones, whatever their scores. A site with no window shows its most common no-go reason.

### Known limitations

- Wind limits and directions come from RMHPA's prose, and some pages are vague or contradictory. Notes on the judgment calls are in the JSON.
- The grid models don't see local effects like rotor, valley flow or which way the LZ wind is blowing.
- The thermal index and cloud base are rough. They nudge the score, but only the low cloud rule can change a call.

## Running it locally

You need Node 24 (`nvm use` picks it up from `.nvmrc`).

```sh
npm ci
npm run dev
```

Then open http://localhost:5173/. See [CONTRIBUTING.md](CONTRIBUTING.md) for tests and the debug URL parameters.

## Deploying

The app deploys to GitHub Pages from `main` with `.github/workflows/pages.yml`. To set it up, create the GitHub repository, push `main`, and in Settings → Pages set the source to "GitHub Actions". The site can be served from any path, so a project page like `https://<user>.github.io/<repo>/` works.
