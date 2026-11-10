import bundledSites from "../../../sites.json";
import { parseSites, parseSources } from "./parseSites";
import type { Site, SiteSource } from "./site";

export interface SiteProvider {
  sites(): Promise<Site[]>;
}

/** Serves the curated catalog, validating it at runtime. A malformed catalog rejects. */
export function bundledSiteProvider(json: unknown = bundledSites): SiteProvider {
  return {
    sites: async () => parseSites(json),
  };
}

/** The bundled catalog's sources. Throws SiteDataError when they're malformed. */
export function bundledSources(json: unknown = bundledSites): SiteSource[] {
  return parseSources(json);
}
