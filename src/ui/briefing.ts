import type { DegreeArc, Launch, Site } from "../core/sites/site";
import { formatLongDayKey } from "../core/time";
import type { DayKey } from "../core/time";
import { compass } from "../core/units";
import { arcLabel, arcsLabel, feet, limitsLine } from "./format";

const PLACEHOLDER_NOTE = " (the site guide publishes no limits; these are this app's placeholder defaults)";

/** The guide's ideal arcs as written: a zero-width arc is one heading, an empty list means any OK direction. */
function guideIdealLabel(ideal: readonly DegreeArc[]): string {
  if (ideal.length === 0) return "anywhere in the OK range";
  return ideal
    .map((a) => {
      if (a.from !== a.to) return arcLabel(a);
      const h = Math.round(a.from);
      return `${h}° (${compass(h)})`;
    })
    .join(", ");
}

/** The launch's wind limits, flagged when they're the curator's placeholder defaults. */
function launchLimits(site: Site, l: Launch): string {
  const note = l.limits === undefined && site.limitsDefaulted === true ? PLACEHOLDER_NOTE : "";
  return `Wind limits ${limitsLine(site, l)}${note}.`;
}

function launchDirections(l: Launch): string {
  if (l.directions.ok.length === 0) return "Directions: not curated.";
  return `Works best ${guideIdealLabel(l.directions.ideal)}. OK ${arcsLabel(l.directions.ok)}.`;
}

/**
 * The prompt that asks an AI chat for its own conditions briefing for a site and day. It takes only
 * the site and the day, so nothing of the app's call, window or score can reach it.
 */
export function briefingPrompt(site: Site, day: DayKey): string {
  const launches = site.launches.map(
    (l) =>
      `- ${l.name}: ${l.coordinate.latitude.toFixed(5)}, ${l.coordinate.longitude.toFixed(5)}, ${feet(l.elevationFt)}. ` +
      `${launchDirections(l)} ${launchLimits(site, l)}`,
  );
  const lines = [
    `I'm a paraglider pilot planning to fly ${site.name} on ${formatLongDayKey(day)}. Give me a weather and conditions briefing for that site and day.`,
    "",
    "Use current forecast data from your own sources (forecast models, soundings, area forecast discussions, current observations), not climatology or typical conditions. Say which sources and model runs you used. If you can't get a current forecast for this day, say so instead of guessing.",
    "",
    "Cover:",
    "- surface and aloft winds (speed, direction, gusts) through the day, against each launch's directions and limits",
    "- thermals and lapse rate",
    "- cloud base",
    "- overdevelopment and thunderstorm risk",
    "- moving weather: fronts, troughs, storm systems, outflow",
    "- the best time window to fly, if any",
    "- go or no-go, with your reasoning",
    "",
    "Give times in the site's local time.",
    "",
    `Site: ${site.name}`,
    `Source: ${site.sourceURL}`,
    "Launches:",
    ...launches,
  ];
  if (site.notes !== undefined) lines.push(`Site notes: ${site.notes}`);
  if (site.soaring !== undefined) lines.push(`Soaring: ${site.soaring.notes}`);
  if (site.xc !== undefined) lines.push(`XC: ${site.xc.notes}`);
  return lines.join("\n");
}

/**
 * The Claude model the Claude link asks for. claude.ai doesn't document `model`, so it may be
 * ignored, and the id needs updating when a newer Opus ships.
 */
export const BRIEFING_CLAUDE_MODEL = "claude-opus-5-5";

/** The Claude and ChatGPT links that open a chat with `prompt` filled in. */
export function briefingLinks(prompt: string): { claude: string; chatgpt: string } {
  const q = encodeURIComponent(prompt);
  return {
    claude: `https://claude.ai/new?model=${BRIEFING_CLAUDE_MODEL}&q=${q}`,
    chatgpt: `https://chatgpt.com/?q=${q}`,
  };
}

/** True for an open flying site on a day that isn't over. */
export function showsBriefing(site: Site, dayOver: boolean): boolean {
  return site.kind === "flying" && site.status.state === "open" && !dayOver;
}

/** What the copy button shows. */
export type CopyState = "idle" | CopyResult;

/** How a copy attempt went. */
export type CopyResult = "copied" | "failed";

/** Writes `text` to the clipboard. "failed" when there is no clipboard (plain http) or the write is refused. */
export async function copyPrompt(
  clipboard: Pick<Clipboard, "writeText"> | undefined,
  text: string,
): Promise<CopyResult> {
  try {
    if (clipboard === undefined) return "failed";
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}
