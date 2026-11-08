export type PressureLevel = 700 | 600 | 500;

export const PRESSURE_LEVELS: readonly PressureLevel[] = [700, 600, 500];

export interface LevelData {
  windMph?: number | undefined;
  windDir?: number | undefined;
  tempC?: number | undefined;
  heightM?: number | undefined;
}

/** One model's forecast for one launch for the hour starting at `time` (epoch ms). */
export interface ModelHour {
  time: number;
  tempC?: number | undefined;
  dewpointC?: number | undefined;
  precipMm?: number | undefined;
  windMph?: number | undefined;
  windDir?: number | undefined;
  gustMph?: number | undefined;
  capeJkg?: number | undefined;
  blhM?: number | undefined;
  lowCloudPct?: number | undefined;
  levels: Partial<Record<PressureLevel, LevelData>>;
}

export interface NeighborWind {
  time: number;
  windMph?: number | undefined;
  windDir?: number | undefined;
}

/**
 * 10 m wind series for the neighbor request's center point (the launch location, snapped to the
 * nearest grid cell). Compare neighbors against this, not against the launch request's wind.
 */
export interface NeighborCenter {
  ecmwf: NeighborWind[];
  rrfs: NeighborWind[];
}

export interface NeighborForecast {
  bearingDeg: number;
  ecmwf: NeighborWind[];
  rrfs: NeighborWind[];
}

export interface DaylightDay {
  sunrise: number;
  sunset: number;
}

export interface LaunchForecast {
  launchID: string;
  ecmwf: ModelHour[];
  rrfs: ModelHour[];
  neighborCenter: NeighborCenter;
  neighbors: NeighborForecast[];
  days: DaylightDay[];
}
