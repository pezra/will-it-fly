import { METERS_PER_FOOT, METERS_PER_MILE, compass } from "../core/units";
import type { Confidence } from "../core/scoring/modelAgreement";
import type { HourCall } from "../core/scoring/hourEvaluator";
import type { TargetDay } from "../core/scoring/windowFinder";
import { SCORING_DEFAULTS } from "../core/scoring/defaults";
import { effectiveIdealArcs } from "../core/scoring/hourEvaluator";
import type { DegreeArc, Launch } from "../core/sites/site";

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

export function dayLabel(day: TargetDay): string {
  return day === "today" ? "Today" : "Tomorrow";
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
