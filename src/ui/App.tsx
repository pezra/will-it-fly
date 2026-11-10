import { useEffect, useState } from "preact/hooks";
import { wantedSiteIds } from "../core/travel/inRange";
import type { ModelName } from "../core/scoring/hourEvaluator";
import type { DebugParams } from "./debugParams";
import { loadDefaultModel, switchModel } from "./modelSettings";
import { resolveRoute } from "./route";
import type { CanonicalRoute } from "./route";
import { SiteDetail } from "./SiteDetail";
import { SiteList } from "./SiteList";
import { localStorageStore } from "./storage";
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
  // Location, prefilter and drive times first; weather only for the sites they leave (or the
  // site page's own site, at once).
  const travel = useTravel(debug);
  const wanted = wantedSiteIds({
    page: route.page,
    routeSiteId: route.page === "site" ? route.id : undefined,
    stage: travel.stage,
    inRangeIds: travel.inRangeIds,
  });
  const recs = useRecommendations(debug, route.day, model, wanted);
  const view = useTravelView(travel, recs);
  // Sets the hash, which pushes a history entry and fires `hashchange`, so Back undoes a switch.
  const setModel = (next: ModelName): void => {
    window.location.hash = switchModel(localStorageStore(), route, next);
  };

  return (
    <>
      <main>
        {route.page === "site" ? (
          <SiteDetail siteId={route.id} day={route.day} model={model} recs={view.recs} catalogIds={view.catalogIds} />
        ) : (
          <SiteList travel={view} day={route.day} model={model} setModel={setModel} />
        )}
      </main>
      <footer>
        Weather data by{" "}
        <a href="https://open-meteo.com/">Open-Meteo.com</a> (CC BY 4.0) · Site info from{" "}
        <a href="https://www.rmhpa.org/">RMHPA</a>, verify before flying · Routing by{" "}
        <a href="https://project-osrm.org/">OSRM</a> and place search by{" "}
        <a href="https://nominatim.org/">Nominatim</a>, ©{" "}
        <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Drive times send your start point, rounded to about 1 km,
        to OSRM.
      </footer>
    </>
  );
}
