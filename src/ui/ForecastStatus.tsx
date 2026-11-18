import { HeldButton } from "./HeldButton";
import type { RecommendationsState } from "./useRecommendations";

/** The loading message, or the load failure with a Retry button (held after a rate limit). */
export function ForecastStatus({
  state,
  retry,
  retryAt,
}: {
  state: Exclude<RecommendationsState, { status: "loaded" }>;
  retry: () => void;
  retryAt: number | undefined;
}) {
  if (state.status === "loading") {
    return <p class="status" role="status">Loading forecast…</p>;
  }
  return (
    <div class="error" role="alert">
      <p><strong>Couldn't load the forecast.</strong></p>
      <p>{state.message}</p>
      <HeldButton label="Retry" retryAt={retryAt} onClick={retry} />
    </div>
  );
}
