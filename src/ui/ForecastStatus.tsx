import type { RecommendationsState } from "./useRecommendations";

/** The loading message, or the load failure with a Retry button. */
export function ForecastStatus({
  state,
  retry,
}: {
  state: Exclude<RecommendationsState, { status: "loaded" }>;
  retry: () => void;
}) {
  if (state.status === "loading") {
    return <p class="status" role="status">Loading forecast…</p>;
  }
  return (
    <div class="error" role="alert">
      <p><strong>Couldn't load the forecast.</strong></p>
      <p>{state.message}</p>
      <button type="button" onClick={retry}>Retry</button>
    </div>
  );
}
