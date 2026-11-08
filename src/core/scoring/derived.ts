import { PRESSURE_LEVELS } from "../forecast/models";
import type { LevelData, ModelHour } from "../forecast/models";
import { normalizedDegrees } from "../sites/degreeArc";
import { definedMax } from "../units";
import { SCORING_DEFAULTS } from "./defaults";
import type { ScoringDefaults } from "./defaults";

/** A wind in meteorological convention: `dirDeg` is where it blows *from*, 0 to under 360. */
export interface Wind {
  speedMph: number;
  dirDeg: number;
}

/** Eastward component: -s*sin(theta). */
export function windU(wind: Wind): number {
  return -wind.speedMph * Math.sin((wind.dirDeg * Math.PI) / 180);
}

/** Northward component: -s*cos(theta). */
export function windV(wind: Wind): number {
  return -wind.speedMph * Math.cos((wind.dirDeg * Math.PI) / 180);
}

/** From components: `u` eastward and `v` northward (the direction the air moves). */
export function windFromComponents(u: number, v: number): Wind {
  const speedMph = Math.hypot(u, v);
  // The explicit 0 also keeps -0 out of dirDeg.
  const dirDeg = speedMph === 0 ? 0 : normalizedDegrees((Math.atan2(-u, -v) * 180) / Math.PI);
  return { speedMph, dirDeg };
}

interface HeightLevel {
  heightM: number;
  data: LevelData;
}

/** Levels that have a height, in ascending height order. */
function levelsByHeight(hour: ModelHour): HeightLevel[] {
  const found: HeightLevel[] = [];
  for (const level of PRESSURE_LEVELS) {
    const data = hour.levels[level];
    if (data?.heightM !== undefined) found.push({ heightM: data.heightM, data });
  }
  return found.sort((a, b) => a.heightM - b.heightM);
}

/**
 * The stronger of the 10 m wind and, for launches at or above Z700, the pressure-level wind
 * interpolated (in u/v, linearly in height) between the two levels bracketing the launch.
 * The direction comes from whichever source supplied the speed; ties go to 10 m.
 *
 * Undefined when the 10 m speed or direction is missing (a core field). If the bracketing levels
 * are incomplete, or the launch is below Z700 or above every level, the 10 m wind is used.
 */
export function launchWind(hour: ModelHour, launchElevationM: number): Wind | undefined {
  if (hour.windMph === undefined || hour.windDir === undefined) return undefined;
  const surface: Wind = { speedMph: hour.windMph, dirDeg: hour.windDir };
  const z700 = hour.levels[700]?.heightM;
  if (z700 === undefined || launchElevationM < z700) return surface;
  const interpolated = interpolatedLevelWind(hour, launchElevationM);
  if (interpolated === undefined || interpolated.speedMph <= surface.speedMph) return surface;
  return interpolated;
}

/**
 * Launch elevation + max(cloud base above launch, BLH), or launch + the fallback when both are
 * missing.
 */
export function topOfLiftM(
  hour: ModelHour,
  launchElevationM: number,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): number {
  const above = definedMax(cloudBaseAboveLaunchM(hour, defaults), hour.blhM);
  return launchElevationM + (above ?? defaults.topOfLiftFallbackAboveLaunchM);
}

/**
 * The strongest wind among levels with Z in [launch + offset, top of lift]. If none is in that
 * band, the lowest level with Z >= launch + offset. Undefined if no level qualifies. A level
 * qualifies only with height, speed and direction all present.
 */
export function aloftWind(
  hour: ModelHour,
  launchElevationM: number,
  topOfLift: number,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): Wind | undefined {
  const floor = launchElevationM + defaults.aloftMinAboveLaunchM;
  const candidates: { heightM: number; wind: Wind }[] = [];
  for (const { heightM, data } of levelsByHeight(hour)) {
    if (heightM < floor) continue;
    if (data.windMph === undefined || data.windDir === undefined) continue;
    candidates.push({ heightM, wind: { speedMph: data.windMph, dirDeg: data.windDir } });
  }
  let strongest: Wind | undefined;
  for (const c of candidates) {
    if (c.heightM > topOfLift) continue;
    // Strictly greater, so ties go to the lowest level.
    if (strongest === undefined || c.wind.speedMph > strongest.speedMph) strongest = c.wind;
  }
  return strongest ?? candidates[0]?.wind;
}

/**
 * (T2m - Td2m) x 125 m/degC. Biased high for launches well above model terrain. Undefined if
 * either input is missing.
 */
export function cloudBaseAboveLaunchM(
  hour: ModelHour,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): number | undefined {
  if (hour.tempC === undefined || hour.dewpointC === undefined) return undefined;
  return (hour.tempC - hour.dewpointC) * defaults.cloudBaseMPerDegSpread;
}

/**
 * T_level - T_parcel at the lowest level >= launch + offset that has height and temperature,
 * with T_parcel = T2m - lapse x (Z_level - launch). Lower is stronger. Undefined if none
 * qualifies.
 */
export function thermalIndex(
  hour: ModelHour,
  launchElevationM: number,
  defaults: ScoringDefaults = SCORING_DEFAULTS,
): number | undefined {
  if (hour.tempC === undefined) return undefined;
  const floor = launchElevationM + defaults.thermalIndexMinAboveLaunchM;
  const level = levelsByHeight(hour).find(
    ({ heightM, data }) => heightM >= floor && data.tempC !== undefined,
  );
  if (level === undefined || level.data.tempC === undefined) return undefined;
  const parcel = hour.tempC - defaults.dryAdiabaticLapseCPerM * (level.heightM - launchElevationM);
  return level.data.tempC - parcel;
}

/**
 * Interpolates between the two adjacent levels (by height) that bracket `elevationM`. The first
 * bracketing pair wins. Undefined if no adjacent pair brackets it or either level lacks wind.
 */
function interpolatedLevelWind(hour: ModelHour, elevationM: number): Wind | undefined {
  const byHeight = levelsByHeight(hour);
  for (let i = 0; i + 1 < byHeight.length; i++) {
    const lo = byHeight[i];
    const hi = byHeight[i + 1];
    if (lo === undefined || hi === undefined) continue;
    if (!(lo.heightM <= elevationM && elevationM <= hi.heightM)) continue;
    const { windMph: s0, windDir: d0 } = lo.data;
    const { windMph: s1, windDir: d1 } = hi.data;
    if (
      hi.heightM <= lo.heightM ||
      s0 === undefined ||
      d0 === undefined ||
      s1 === undefined ||
      d1 === undefined
    ) {
      return undefined;
    }
    const a: Wind = { speedMph: s0, dirDeg: d0 };
    const b: Wind = { speedMph: s1, dirDeg: d1 };
    const t = (elevationM - lo.heightM) / (hi.heightM - lo.heightM);
    const u = windU(a) + t * (windU(b) - windU(a));
    const v = windV(a) + t * (windV(b) - windV(a));
    return windFromComponents(u, v);
  }
  return undefined;
}
