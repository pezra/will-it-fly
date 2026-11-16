import type { Site } from "../core/sites/site";
import { formatLongDayKey } from "../core/time";
import type { DayKey } from "../core/time";
import { arcsLabel, feet, idealLabel, limitsLine } from "./format";

/**
 * The prompt that asks an AI chat for its own conditions briefing for a site and day. It takes only
 * the site and the day, so nothing of the app's call, window or score can reach it.
 */
export function briefingPrompt(site: Site, day: DayKey): string {
  const launches = site.launches.map(
    (l) =>
      `- ${l.name}: ${l.coordinate.latitude.toFixed(5)}, ${l.coordinate.longitude.toFixed(5)}, ${feet(l.elevationFt)}. ` +
      `Works best ${idealLabel(l)}. OK ${arcsLabel(l.directions.ok)}. Wind limits ${limitsLine(site, l)}.`,
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

/** The Claude and ChatGPT links that open a chat with `prompt` filled in. */
export function briefingLinks(prompt: string): { claude: string; chatgpt: string } {
  const q = encodeURIComponent(prompt);
  return { claude: `https://claude.ai/new?q=${q}`, chatgpt: `https://chatgpt.com/?q=${q}` };
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
