import { useEffect, useState } from "preact/hooks";
import { wantedSiteIds } from "../core/travel/inRange";
import type { DebugParams } from "./debugParams";
import { parseRoute } from "./route";
import type { Route } from "./route";
import { SiteDetail } from "./SiteDetail";
import { SiteList } from "./SiteList";
import { useRecommendations } from "./useRecommendations";
import { useTravel, useTravelView } from "./useTravel";

function useHashRoute(): Route {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = (): void => {
      setHash(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return parseRoute(hash);
}

export function App({ debug }: { debug: DebugParams }) {
  const route = useHashRoute();
  // Location, prefilter and drive times first; weather only for the sites they leave (or the
  // site page's own site, at once).
  const travel = useTravel(debug);
  const wanted = wantedSiteIds({
    page: route.page,
    routeSiteId: route.page === "site" ? route.id : undefined,
    stage: travel.stage,
    inRangeIds: travel.inRangeIds,
  });
  const recs = useRecommendations(debug, route.day, wanted);
  const view = useTravelView(travel, recs);

  return (
    <>
      <main>
        {route.page === "site" ? (
          <SiteDetail siteId={route.id} day={route.day} recs={view.recs} />
        ) : (
          <SiteList travel={view} day={route.day} />
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
