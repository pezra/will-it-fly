import { launchRequestURL, neighborRequestURL, splitRaw } from "../../src/core/forecast/openMeteoClient";
import type { RawSlice } from "../../src/core/forecast/openMeteoClient";
import { bundledSiteProvider } from "../../src/core/sites/siteProvider";
import type { Site } from "../../src/core/sites/site";
import type { DayKey } from "../../src/core/time";
import launchesJSON from "../fixtures/openmeteo-launches.json?raw";
import neighborsJSON from "../fixtures/openmeteo-neighbors.json?raw";

export const GLENWOOD = "rmhpa/glenwood-lookout-mtn";
export const BUTTE = "rmhpa/crested-butte";
export const BOULDER = "rmhpa/boulder-wonderland";
export const COPPER = "rmhpa/copper-mountain";

/**
 * The three real sites the Open-Meteo fixture was recorded for, trimmed to the recorded launch and
 * in the recorded order, and Copper (closed).
 */
export async function fixtureSites(): Promise<Site[]> {
  const all = await bundledSiteProvider().sites();
  const trimmed = (siteID: string, launchID: string): Site => {
    const site = all.find((s) => s.id === siteID);
    const launch = site?.launches.find((l) => l.id === launchID);
    if (site === undefined || launch === undefined) throw new Error(`no ${launchID}`);
    return { ...site, launches: [launch] };
  };
  const copper = all.find((s) => s.id === COPPER);
  if (copper === undefined) throw new Error("no copper");
  return [
    trimmed(GLENWOOD, `${GLENWOOD}/north`),
    trimmed(BUTTE, `${BUTTE}/browns`),
    trimmed(BOULDER, `${BOULDER}/upper`),
    copper,
  ];
}

const RECORDED = [GLENWOOD, BUTTE, BOULDER];
const recordedSlices = splitRaw(launchesJSON, neighborsJSON, [1, 1, 1]);

/** An open fixture site's slice of the recorded responses. */
export function fixtureSlice(id: string): RawSlice {
  const slice = recordedSlices[RECORDED.indexOf(id)];
  if (slice === undefined) throw new Error(`no recorded slice for ${id}`);
  return slice;
}

/** The recorded response bodies for exactly these fixture sites, in this order. */
export function fixtureBodies(ids: readonly string[]): { launchBody: string; neighborBody: string } {
  const join = (part: keyof RawSlice): string =>
    JSON.stringify(ids.flatMap((id) => JSON.parse(fixtureSlice(id)[part]) as unknown[]));
  return { launchBody: join("launchRaw"), neighborBody: join("neighborRaw") };
}

/**
 * Serves the recorded bodies for the request pair of exactly these sites (in this order), and
 * returns undefined for any other URL.
 */
export function fixtureResponse(
  sites: readonly Site[],
  ids: readonly string[],
  url: string,
  day?: DayKey,
): string | undefined {
  const launches = ids.flatMap((id) => sites.find((s) => s.id === id)?.launches ?? []);
  if (url === launchRequestURL(launches, undefined, day)) return fixtureBodies(ids).launchBody;
  if (url === neighborRequestURL(launches, undefined, day)) return fixtureBodies(ids).neighborBody;
  return undefined;
}
