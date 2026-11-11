import { METERS_PER_FOOT, METERS_PER_MILE, MINUTES_PER_HOUR, SECONDS_PER_MINUTE, compass } from "../core/units";
import type { DriveTime } from "../core/travel/driveTime";
import type { TravelStage } from "../core/travel/inRange";
import type { Confidence } from "../core/scoring/modelAgreement";
import type { SiteRecommendation } from "../core/recommendation/types";
import type { HourCall, HourCondition, ModelName, Reason } from "../core/scoring/hourEvaluator";
import { SCORING_DEFAULTS } from "../core/scoring/defaults";
import { CHECK_MODEL, MODEL_LABEL, effectiveIdealArcs } from "../core/scoring/hourEvaluator";
import type { Coordinate, DegreeArc, Launch, SiteKind } from "../core/sites/site";
import { addDays, formatDayKey } from "../core/time";
import type { DayKey } from "../core/time";
import type { LocationStatus } from "./location";
import { radiusLabel, radiusMinutes } from "./travelSettings";
import type { TravelSettings } from "./travelSettings";

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

/** The link text for a site's source: its host without "www.", e.g. "rmhpa.org". */
export function sourceLabel(sourceURL: string): string {
  return new URL(sourceURL).hostname.replace(/^www\./, "");
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

export function callLabel(call: "noGo" | "noData"): string {
  switch (call) {
    case "noGo":
      return "No-go";
    case "noData":
      return "No data";
  }
}

/** A glyph that backs up the color, so a call never relies on color alone. */
export function callGlyph(call: "noGo" | "noData"): string {
  switch (call) {
    case "noGo":
      return "✕";
    case "noData":
      return "–";
  }
}

export const CONDITION_LABEL: Readonly<Record<HourCondition, string>> = {
  soar: "Soar",
  xc: "XC",
  sledder: "Sledder",
  kite: "Kite",
};

/**
 * How a good or flyable hour shows its call: condition pills, with Sledder when there are none so
 * a pill is never blank. No-go, no-data and closed show a badge instead.
 */
export function callDisplay(
  call: HourCall | "closed",
  conditions: readonly HourCondition[] | undefined,
):
  | { kind: "pills"; conditions: readonly HourCondition[] }
  | { kind: "badge"; call: "noGo" | "noData" | "closed" } {
  if (call === "good" || call === "flyable") {
    const hasConditions = conditions !== undefined && conditions.length > 0;
    return { kind: "pills", conditions: hasConditions ? conditions : ["sledder"] };
  }
  return { kind: "badge", call };
}

/** "⚠ wind 28 mph, low cloud +1 more": the first `max` cautions, then a count of the rest. */
export function cautionLine(cautions: readonly Reason[], max = 2): string | undefined {
  if (cautions.length === 0) return undefined;
  const shown = cautions.slice(0, max).map((c) => c.text).join(", ");
  const more = cautions.length - max;
  return more > 0 ? `⚠ ${shown} +${more} more` : `⚠ ${shown}`;
}

/** How sure a window is. `model` is the launch's primary model, named when it had no cross-check. */
export function confidenceLabel(confidence: Confidence, model: ModelName): string {
  switch (confidence) {
    case "high":
      return "high confidence";
    case "medium":
      return "medium confidence";
    case "low":
      return "low confidence";
    case "primaryOnly":
      return `${MODEL_LABEL[model]} only`;
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
 * The travel bar's collapsed line: "Within 2 h of Boulder · RRFS" (`mode`'s radius and the route's
 * model), or a prompt when there is no start. While the location is still pending and nothing else
 * is chosen, it says so instead.
 */
export function travelSummary(
  settings: TravelSettings,
  effectiveStart: Coordinate | undefined,
  location: LocationStatus,
  model: ModelName,
  mode: SiteKind,
): string {
  if (effectiveStart === undefined) {
    return settings.start.kind === "geolocation" && location === "pending"
      ? "Finding your location…"
      : "Set a starting point";
  }
  const where = settings.start.kind === "place" ? settings.start.name : "your location";
  return `Within ${radiusLabel(radiusMinutes(settings, mode))} of ${where} · ${MODEL_LABEL[model]}`;
}

/**
 * The list's note when RRFS was asked for and some of the shown sites used ECMWF instead. A site
 * counts when any of its launches fell back; sites with no launch evaluations (closed ones) aren't
 * counted at all. Undefined for ECMWF and when nothing fell back.
 */
export function fallbackLine(
  model: ModelName,
  shown: readonly SiteRecommendation[],
): string | undefined {
  if (model !== "rrfs") return undefined;
  const evaluated = shown.filter((rec) => rec.launches.length > 0);
  const fellBack = evaluated.filter((rec) => rec.launches.some((l) => l.fellBack)).length;
  if (fellBack === 0) return undefined;
  if (fellBack === evaluated.length) return "RRFS doesn't cover this day, so it uses ECMWF.";
  return `${fellBack} ${fellBack === 1 ? "site uses" : "sites use"} ECMWF (RRFS doesn't cover this day).`;
}

/**
 * The model behind a site's call: its best launch's, else the one model every launch used (all of
 * them fell back, say), else the requested one.
 */
export function siteModel(rec: SiteRecommendation, requested: ModelName): ModelName {
  if (rec.best !== undefined) return rec.best.model;
  const models = new Set(rec.launches.map((l) => l.model));
  const [only] = models;
  return models.size === 1 && only !== undefined ? only : requested;
}

/** The site page's note on a launch that fell back from RRFS to ECMWF. */
export const launchFallbackNote = "RRFS doesn't cover this day here, so this launch uses ECMWF.";

/** One column of the hourly table: what it shows, and which model's data it reads. */
export interface HourlyColumn {
  header: string;
  value: "time" | "call" | "wind" | "cape" | "cloudBase" | "thermalIndex";
  /** Whose hour the column reads. Undefined for the time column. */
  side?: "primary" | "check";
  /** True for the wind column that also shows the hour's gust. */
  withGust?: boolean;
}

/**
 * The hourly table's columns, in order, for a launch whose primary model is `model`: the primary
 * model first, then the check model. CAPE, cloud base and TI come from the primary model.
 */
export function hourlyColumns(model: ModelName): readonly HourlyColumn[] {
  const primary = MODEL_LABEL[model];
  const check = MODEL_LABEL[CHECK_MODEL[model]];
  return [
    { header: "Time", value: "time" },
    { header: primary, value: "call", side: "primary" },
    { header: "Wind / gust / dir", value: "wind", side: "primary", withGust: true },
    { header: check, value: "call", side: "check" },
    { header: `${check} wind / dir`, value: "wind", side: "check" },
    { header: "CAPE J/kg", value: "cape", side: "primary" },
    { header: "Cloud base", value: "cloudBase", side: "primary" },
    { header: "TI °C", value: "thermalIndex", side: "primary" },
  ];
}

/**
 * "3 sites hidden (over 2 h away)". `radius` is the limit as `radiusLabel` says it ("2 h",
 * "30 min"). Only shown when a limit hides something. With the number of sites of the listed kind,
 * hiding every site reads "All 21 sites are over 2 h away".
 */
export function hiddenLine(hiddenCount: number, radius: string, total?: number): string {
  if (total !== undefined && total > 0 && hiddenCount >= total) {
    return total === 1
      ? `The only site is over ${radius} away`
      : `All ${total} sites are over ${radius} away`;
  }
  const noun = hiddenCount === 1 ? "site" : "sites";
  return `${hiddenCount} ${noun} hidden (over ${radius} away)`;
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
