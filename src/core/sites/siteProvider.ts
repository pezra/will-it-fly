import bundledSites from "../../../sites.json";
import { parseSites } from "./parseSites";
import type { Site } from "./site";

export interface SiteProvider {
  sites(): Promise<Site[]>;
}

/** Serves the curated catalog, validating it at runtime. A malformed catalog rejects. */
export function bundledSiteProvider(json: unknown = bundledSites): SiteProvider {
  return {
    sites: async () => parseSites(json),
  };
}
