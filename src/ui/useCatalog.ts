import { useEffect, useState } from "preact/hooks";
import type { Site } from "../core/sites/site";
import { bundledSiteProvider } from "../core/sites/siteProvider";

let catalog: Promise<Site[]> | undefined;

/** The bundled catalog, read once. A failure is not kept, so the next call tries again. */
function loadCatalog(): Promise<Site[]> {
  catalog ??= bundledSiteProvider()
    .sites()
    .catch((error: unknown) => {
      catalog = undefined;
      throw error;
    });
  return catalog;
}

/** The bundled site catalog, undefined until it is read. A failed read is logged and stays undefined. */
export function useCatalog(): Site[] | undefined {
  const [sites, setSites] = useState<Site[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    loadCatalog().then(
      (all) => {
        if (!cancelled) setSites(all);
      },
      (error: unknown) => console.error("Could not read the site catalog", error),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return sites;
}
