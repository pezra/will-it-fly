import { METERS_PER_FOOT, METERS_PER_MILE, compass } from "../core/units";
import type { DriveTime } from "../core/travel/driveTime";
import type { TravelStage } from "../core/travel/inRange";
import type { Confidence } from "../core/scoring/modelAgreement";
import type { HourCall } from "../core/scoring/hourEvaluator";
import { SCORING_DEFAULTS } from "../core/scoring/defaults";
import { effectiveIdealArcs } from "../core/scoring/hourEvaluator";
import type { Coordinate, DegreeArc, Launch } from "../core/sites/site";
import { addDays, formatDayKey } from "../core/time";
import type { DayKey } from "../core/time";
import type { LocationStatus } from "./location";
import type { MaxHours, TravelSettings } from "./travelSettings";

/** Feet from meters, rounded to the nearest 100 ft, as "≈ 9,200 ft". "n/a" when missing. */
export function approxFeet(meters: number | undefined): string {
  if (meters === undefined) return "n/a";
  const ft = Math.round(meters / METERS_PER_FOOT / 100) * 100;
  return `≈ ${ft.toLocaleString("en-US")} ft`;
}

/** Whole feet with a thousands separator: "9,200 ft". */
export function feet(ft: number): string {
  return `${Math.round(ft).toLocaleString("en-US")} ft`;
}

/** Miles from meters: "12 mi" (one decimal under 10). */
export function miles(meters: number | undefined): string | undefined {
  if (meters === undefined) return undefined;
  const mi = meters / METERS_PER_MILE;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

/** "Forecast from 3 h ago", "12 min ago", "just now". Negative ages count as just now. */
export function forecastAge(fetchedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - fetchedAt) / 60_000);
  if (minutes < 1) return "Forecast from just now";
  if (minutes < 60) return `Forecast from ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Forecast from ${hours} h ago`;
  return `Forecast from ${Math.floor(hours / 24)} days ago`;
}

/** "270–310°" (with compass names), for a launch direction arc. */
export function arcLabel(arc: DegreeArc): string {
  const from = Math.round(arc.from);
  const to = Math.round(arc.to);
  return `${from}–${to}° (${compass(from)}–${compass(to)})`;
}

export function arcsLabel(arcs: readonly DegreeArc[]): string {
  return arcs.length === 0 ? "none" : arcs.map(arcLabel).join(", ");
}

const wrap360 = (deg: number): number => (deg < 0 ? deg + 360 : deg > 360 ? deg - 360 : deg);

/**
 * The directions scoring treats as ideal: the ideal arcs (a zero-width one widened to heading
 * plus or minus the half-width, wrapped to 0-359), or "anywhere in the OK range" when none.
 */
export function idealLabel(launch: Launch): string {
  if (launch.directions.ideal.length === 0) return "anywhere in the OK range";
  return arcsLabel(
    effectiveIdealArcs(launch, SCORING_DEFAULTS).map((a) => ({ from: wrap360(a.from), to: wrap360(a.to) })),
  );
}

/** "Today", "Tomorrow" or "Tue, Nov 10". */
export function dayLabel(day: DayKey, today: DayKey): string {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  return formatDayKey(day);
}

export function callLabel(call: HourCall): string {
  switch (call) {
    case "good":
      return "Good";
    case "flyable":
      return "Flyable";
    case "noGo":
      return "No-go";
    case "noData":
      return "No data";
  }
}

/** A glyph that backs up the color, so a call never relies on color alone. */
export function callGlyph(call: HourCall): string {
  switch (call) {
    case "good":
      return "✓";
    case "flyable":
      return "~";
    case "noGo":
      return "✕";
    case "noData":
      return "–";
  }
}

export function confidenceLabel(confidence: Confidence): string {
  switch (confidence) {
    case "high":
      return "high confidence";
    case "medium":
      return "medium confidence";
    case "low":
      return "low confidence";
    case "ecmwfOnly":
      return "ECMWF only";
  }
}

/** "1,400" or "n/a". */
export function whole(value: number | undefined): string {
  return value === undefined ? "n/a" : Math.round(value).toLocaleString("en-US");
}

/** "-2.1" with a real minus sign, or "n/a". */
export function oneDecimal(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(1).replace("-", "−");
}

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/**
 * "1h 20m", "45m" or "2h": whole minutes, rounded up, so a site labelled "2h" is never hidden by a
 * 2 h limit. Estimates get a leading "≈ ".
 */
export function driveLabel(driveTime: DriveTime): string {
  const minutes = Math.ceil(driveTime.seconds / SECONDS_PER_MINUTE);
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;
  const text =
    hours === 0 ? `${rest}m` : rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  return driveTime.source === "estimate" ? `≈ ${text}` : text;
}

/**
 * The travel bar's collapsed line: "Within 2 h of Boulder", or a prompt when there is no start.
 * While the location is still pending and nothing else is chosen, it says so instead.
 */
export function travelSummary(
  settings: TravelSettings,
  effectiveStart: Coordinate | undefined,
  location: LocationStatus,
): string {
  if (effectiveStart === undefined) {
    return settings.start.kind === "geolocation" && location === "pending"
      ? "Finding your location…"
      : "Set a starting point";
  }
  const where = settings.start.kind === "place" ? settings.start.name : "your location";
  return `Within ${settings.maxHours} h of ${where}`;
}

/**
 * "3 sites hidden (over 2 h away)". Only shown when a limit hides something. With the catalog
 * size, hiding every site reads "All 21 sites are over 2 h away".
 */
export function hiddenLine(hiddenCount: number, maxHours: MaxHours, total?: number): string {
  if (total !== undefined && total > 0 && hiddenCount >= total) {
    return total === 1
      ? `The only site is over ${maxHours} h away`
      : `All ${total} sites are over ${maxHours} h away`;
  }
  const noun = hiddenCount === 1 ? "site" : "sites";
  return `${hiddenCount} ${noun} hidden (over ${maxHours} h away)`;
}

/** What the list says while it waits on the start or the drive times. Nothing once ready. */
export function stageMessage(stage: TravelStage): string | undefined {
  switch (stage) {
    case "locating":
      return "Finding your location…";
    case "routing":
      return "Finding sites in range…";
    case "needsStart":
      return "Set a starting point";
    case "ready":
      return undefined;
  }
}

/** "Loading 4 more sites…", for in-range sites whose weather is still coming. */
export function loadingMoreLine(count: number): string {
  return `Loading ${count} more ${count === 1 ? "site" : "sites"}…`;
}

/** The message of an Error, else String(error). */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
