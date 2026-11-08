import type { LevelData, ModelHour, PressureLevel } from "../../src/core/forecast/models";

/**
 * Builds `ModelHour`s for tests, starting from a "perfect hour" and applying modifiers.
 *
 * The perfect hour assumes a launch at `PERFECT_LAUNCH_ELEVATION_M` (2000 m, below Z700) facing
 * west (ok and ideal arcs around 270 degrees), with site limits that put 10 mph at ideal:
 * - surface: 20 C / 5 C dewpoint (cloud base (20-5)*125 = 1875 m, about 6152 ft above launch),
 *   no precip, 10 mph from 270, gust 12 mph (gust factor 2), CAPE 100 J/kg (< 200),
 *   BLH 2000 m, low cloud 0%.
 * - top of lift = 2000 + max(1875, 2000) = 4000 m.
 * - 700 hPa: Z 3100 m, 12 mph from 270, 2 C   (in the aloft band 2600-4000 m)
 * - 600 hPa: Z 4400 m, 15 mph from 275, -7.5 C (above top of lift)
 * - 500 hPa: Z 5800 m, 20 mph from 280, -18 C
 * - TI: lowest level >= 2000 + 1200 = 3200 m is 600 hPa (Z 4400).
 *   parcel = 20 - 0.0098 * 2400 = -3.52; TI = -7.5 - (-3.52) = -3.98 (<= -3).
 */
export const PERFECT_LAUNCH_ELEVATION_M = 2000;

/** 2026-07-15 18:00 UTC (noon MDT), in epoch ms. Fixed, never `Date.now()`. */
export const REFERENCE_TIME = 1_784_138_400_000;

function copyHour(hour: ModelHour): ModelHour {
  const levels: ModelHour["levels"] = {};
  for (const [key, data] of Object.entries(hour.levels)) {
    levels[Number(key) as PressureLevel] = { ...data };
  }
  return { ...hour, levels };
}

export interface HourBuilder {
  with(change: (hour: ModelHour) => void): HourBuilder;
  /** Modifies one pressure level, creating it if absent. */
  level(level: PressureLevel, change: (data: LevelData) => void): HourBuilder;
  withoutLevel(level: PressureLevel): HourBuilder;
  build(): ModelHour;
}

function builderFor(hour: ModelHour): HourBuilder {
  const self: HourBuilder = {
    with(change) {
      const copy = copyHour(hour);
      change(copy);
      return builderFor(copy);
    },
    level(level, change) {
      return self.with((h) => {
        const data: LevelData = h.levels[level] ?? {};
        change(data);
        h.levels[level] = data;
      });
    },
    withoutLevel(level) {
      return self.with((h) => {
        delete h.levels[level];
      });
    },
    build() {
      return copyHour(hour);
    },
  };
  return self;
}

export function perfectHour(time: number = REFERENCE_TIME): HourBuilder {
  return builderFor({
    time,
    tempC: 20,
    dewpointC: 5,
    precipMm: 0,
    windMph: 10,
    windDir: 270,
    gustMph: 12,
    capeJkg: 100,
    blhM: 2000,
    lowCloudPct: 0,
    levels: {
      700: { windMph: 12, windDir: 270, tempC: 2, heightM: 3100 },
      600: { windMph: 15, windDir: 275, tempC: -7.5, heightM: 4400 },
      500: { windMph: 20, windDir: 280, tempC: -18, heightM: 5800 },
    },
  });
}

export function isClose(a: number | undefined, b: number, tolerance = 1e-6): boolean {
  return a !== undefined && Math.abs(a - b) <= tolerance;
}
