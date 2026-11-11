import { Fragment } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { SiteSource } from "../core/sites/site";
import { bundledSources } from "../core/sites/siteProvider";
import { wantedSiteIds } from "../core/travel/inRange";
import type { ModelName } from "../core/scoring/hourEvaluator";
import type { DebugParams } from "./debugParams";
import { loadDefaultModel, switchModel } from "./modelSettings";
import { activeMode, resolveRoute } from "./route";
import type { CanonicalRoute } from "./route";
import { SiteDetail } from "./SiteDetail";
import { SiteList } from "./SiteList";
import { localStorageStore } from "./storage";
import { useCatalog } from "./useCatalog";
import { useRecommendations } from "./useRecommendations";
import { useTravel, useTravelView } from "./useTravel";

/**
 * The route for the current hash. A hash that isn't canonical (no model, say) is rewritten in
 * place, with no new history entry, to the one with the saved default model. The default is read
 * on every call, so it is never stale.
 */
function currentRoute(): CanonicalRoute {
  const { route, rewrite } = resolveRoute(window.location.hash, loadDefaultModel(localStorageStore()));
  if (rewrite !== undefined) window.history.replaceState(null, "", rewrite);
  return route;
}

/** The sources to credit in the footer. A malformed list credits none rather than breaking the page. */
function footerSources(): SiteSource[] {
  try {
    return bundledSources();
  } catch {
    return [];
  }
}

const SOURCES = footerSources();

/** "A, B and C", each linked to its source. */
function SourceLinks({ sources }: { sources: SiteSource[] }) {
  return (
    <>
      {sources.map((s, i) => (
        <Fragment key={s.id}>
          {i === 0 ? "" : i === sources.length - 1 ? " and " : ", "}
          <a href={s.url}>{s.name}</a>
        </Fragment>
      ))}
    </>
  );
}

/** The current route, canonical from the first render on. */
function useHashRoute(): CanonicalRoute {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    // `replaceState` fires no `hashchange`, so a rewrite here doesn't come back around.
    const onChange = (): void => {
      setRoute(currentRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function App({ debug }: { debug: DebugParams }) {
  const route = useHashRoute();
  const { model } = route;
  const catalog = useCatalog();
  const catalogIds = useMemo(() => catalog && new Set(catalog.map((s) => s.id)), [catalog]);
  // A list's own mode, else the site's kind on its page (Fly until the catalog is read).
  const mode = activeMode(route, catalog);
  // Location, prefilter and drive times first; weather only for the sites they leave (or the
  // site page's own site, at once).
  const travel = useTravel(debug, catalog, mode);
  const wanted = wantedSiteIds({
    page: route.page,
    routeSiteId: route.page === "site" ? route.id : undefined,
    stage: travel.stage,
    inRangeIds: travel.inRangeIds,
  });
  // The route's mode, not the site's kind on its page: see `useRecommendations`.
  const recs = useRecommendations(debug, route.day, model, route.page === "list" ? route.mode : undefined, wanted);
  const view = useTravelView(travel, recs);
  // Sets the hash, which pushes a history entry and fires `hashchange`, so Back undoes a switch.
  const setModel = (next: ModelName): void => {
    window.location.hash = switchModel(localStorageStore(), route, next);
  };

  return (
    <>
      <main>
        {route.page === "site" ? (
          <SiteDetail siteId={route.id} day={route.day} model={model} mode={mode} recs={view.recs} catalogIds={catalogIds} />
        ) : (
          <SiteList travel={view} day={route.day} model={model} setModel={setModel} />
        )}
      </main>
      <footer>
        Weather data by{" "}
        <a href="https://open-meteo.com/">Open-Meteo.com</a> (CC BY 4.0) · Site info from{" "}
        <SourceLinks sources={SOURCES} />, verify before flying · Routing by{" "}
        <a href="https://project-osrm.org/">OSRM</a> and place search by{" "}
        <a href="https://nominatim.org/">Nominatim</a>, ©{" "}
        <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Drive times send your start point, rounded to about 1 km,
        to OSRM.
      </footer>
    </>
  );
}
