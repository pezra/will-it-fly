import { useEffect, useState } from "preact/hooks";
import type { DebugParams } from "./debugParams";
import { parseRoute } from "./route";
import type { Route } from "./route";
import { SiteDetail } from "./SiteDetail";
import { SiteList } from "./SiteList";
import { useRecommendations } from "./useRecommendations";

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
  const recs = useRecommendations(debug);

  return (
    <>
      <main>
        {route.page === "site" ? (
          <SiteDetail siteId={route.id} recs={recs} />
        ) : (
          <SiteList recs={recs} />
        )}
      </main>
      <footer>
        Weather data by{" "}
        <a href="https://open-meteo.com/">Open-Meteo.com</a> (CC BY 4.0) · Site info from{" "}
        <a href="https://www.rmhpa.org/">RMHPA</a>, verify before flying
      </footer>
    </>
  );
}
