import { describe, expect, it } from "vitest";
import type { ModelName } from "../../src/core/scoring/hourEvaluator";
import type { RecommendationResult } from "../../src/core/recommendation/types";
import type { SiteKind } from "../../src/core/sites/site";
import type { DayKey } from "../../src/core/time";
import { droppedState, loadDecision, pendingState, visibleState } from "../../src/ui/useRecommendations";
import type { PendingLoad, RecommendationsState } from "../../src/ui/useRecommendations";
import { testSite } from "../support/builders";

const DAY: DayKey = "2026-11-10";
const OTHER_DAY: DayKey = "2026-11-11";

function result(model: ModelName, ids: readonly string[]): RecommendationResult {
  return {
    model,
    day: DAY,
    today: "2026-11-09",
    dayOver: false,
    fetchedAt: 0,
    isOffline: false,
    sites: ids.map((id) => ({ site: testSite({ id }), call: "noGo", launches: [] })),
  };
}

function loaded(
  model: ModelName,
  ids: readonly string[],
  extra: {
    requested?: DayKey | undefined;
    mode?: SiteKind | undefined;
    refreshing?: boolean;
    refreshError?: string;
  } = {},
): RecommendationsState {
  const { refreshing = false, refreshError } = extra;
  // `requested: undefined` is the default day, not "use DAY", and `mode: undefined` a site page's load.
  const requested = "requested" in extra ? extra.requested : DAY;
  const mode = "mode" in extra ? extra.mode : "flying";
  const state: RecommendationsState = { status: "loaded", requested, mode, result: result(model, ids), refreshing };
  return refreshError === undefined ? state : { ...state, refreshError };
}

function pending(
  model: ModelName,
  ids: readonly string[],
  day: DayKey | undefined = DAY,
  mode: SiteKind | undefined = "flying",
): PendingLoad {
  return { day, model, mode, ids };
}

const LOADING: RecommendationsState = { status: "loading" };
const FAILED: RecommendationsState = { status: "failed", message: "offline" };

describe("loadDecision", () => {
  it("dropsWhenTheSameDayModelAndIdsAreLoadedAndNothingIsPending", () => {
    const prev = loaded("ecmwf", ["a", "b"]);
    expect(loadDecision(prev, DAY, "ecmwf", "flying", ["a", "b"], undefined)).toBe("drop");
    expect(loadDecision(prev, DAY, "ecmwf", "flying", ["b"], undefined)).toBe("drop");
  });

  it("keepsAnInFlightLoadThatCoversTheIdsForTheSameDayAndModel", () => {
    const prev = loaded("ecmwf", ["a", "b"]);
    expect(loadDecision(prev, DAY, "ecmwf", "flying", ["a", "b"], pending("ecmwf", ["a", "b"]))).toBe("keep");
    // A pending load for more ids still covers.
    expect(loadDecision(prev, DAY, "ecmwf", "flying", ["a"], pending("ecmwf", ["a", "b", "c"]))).toBe("keep");
  });

  it("loadsTheSameDayAndIdsForAnotherModel", () => {
    expect(loadDecision(loaded("ecmwf", ["a", "b"]), DAY, "rrfs", "flying", ["a", "b"], undefined)).toBe("load");
    expect(loadDecision(loaded("rrfs", ["a", "b"]), DAY, "ecmwf", "flying", ["a"], undefined)).toBe("load");
  });

  it("loadsTheSameDayModelAndIdsForAnotherMode", () => {
    expect(loadDecision(loaded("ecmwf", ["a", "b"]), DAY, "ecmwf", "kiting", ["a", "b"], undefined)).toBe("load");
    const kite = loaded("ecmwf", ["a", "b"], { mode: "kiting" });
    expect(loadDecision(kite, DAY, "ecmwf", "flying", ["a"], undefined)).toBe("load");
  });

  it("loadsAListOverASitePagesResult", () => {
    // A site page's own load has no mode, so no list takes it as its own.
    const sitePage = loaded("ecmwf", ["a"], { mode: undefined });
    expect(loadDecision(sitePage, DAY, "ecmwf", "flying", ["a"], undefined)).toBe("load");
    expect(loadDecision(sitePage, DAY, "ecmwf", "kiting", ["a"], undefined)).toBe("load");
  });

  it("doesNotReloadASitePageWhoseSiteIsInAListsResult", () => {
    for (const mode of ["flying", "kiting"] as const) {
      expect(loadDecision(loaded("ecmwf", ["a", "b"], { mode }), DAY, "ecmwf", undefined, ["b"], undefined)).toBe(
        "drop",
      );
    }
    expect(loadDecision(loaded("ecmwf", ["a"], { mode: undefined }), DAY, "ecmwf", undefined, ["a"], undefined)).toBe(
      "drop",
    );
  });

  it("loadsASitePageWhoseSiteIsMissingOrIsForAnotherDayOrModel", () => {
    const kite = loaded("ecmwf", ["a"], { mode: "kiting" });
    expect(loadDecision(kite, DAY, "ecmwf", undefined, ["b"], undefined)).toBe("load");
    expect(loadDecision(kite, OTHER_DAY, "ecmwf", undefined, ["a"], undefined)).toBe("load");
    expect(loadDecision(kite, DAY, "rrfs", undefined, ["a"], undefined)).toBe("load");
  });

  it("keepsASitePagesOwnLoadInFlight", () => {
    // A Refresh on the site page: the next render must not restart it.
    const prev = loaded("ecmwf", ["a"], { mode: undefined, refreshing: true });
    expect(loadDecision(prev, DAY, "ecmwf", undefined, ["a"], pending("ecmwf", ["a"], DAY, undefined))).toBe("keep");
    // A list's load in flight that has the site lands as a result the site page takes.
    const kite = loaded("ecmwf", ["a", "b"], { mode: "kiting", refreshing: true });
    expect(loadDecision(kite, DAY, "ecmwf", undefined, ["a"], pending("ecmwf", ["a", "b"], DAY, "kiting"))).toBe(
      "keep",
    );
  });

  it("loadsAnotherDay", () => {
    expect(loadDecision(loaded("ecmwf", ["a"]), OTHER_DAY, "ecmwf", "flying", ["a"], undefined)).toBe("load");
    expect(loadDecision(loaded("ecmwf", ["a"]), undefined, "ecmwf", "flying", ["a"], undefined)).toBe("load");
    const defaultDay = loaded("ecmwf", ["a"], { requested: undefined });
    expect(loadDecision(defaultDay, DAY, "ecmwf", "flying", ["a"], undefined)).toBe("load");
  });

  it("loadsIdsTheResultIsMissing", () => {
    expect(loadDecision(loaded("ecmwf", ["a"]), DAY, "ecmwf", "flying", ["a", "b"], undefined)).toBe("load");
    // Even with a covering load in flight: the effect only keeps one when nothing needs loading.
    expect(
      loadDecision(loaded("ecmwf", ["a"]), DAY, "ecmwf", "flying", ["a", "b"], pending("ecmwf", ["a", "b"])),
    ).toBe("load");
  });

  it("loadsFromAFailedOrLoadingState", () => {
    expect(loadDecision(FAILED, DAY, "ecmwf", "flying", ["a"], undefined)).toBe("load");
    expect(loadDecision(LOADING, DAY, "ecmwf", "flying", ["a"], undefined)).toBe("load");
    expect(loadDecision(LOADING, DAY, "ecmwf", "flying", [], undefined)).toBe("load");
  });

  it("dropsAnInFlightLoadForAnotherModel", () => {
    const prev = loaded("ecmwf", ["a", "b"]);
    expect(loadDecision(prev, DAY, "ecmwf", "flying", ["a", "b"], pending("rrfs", ["a", "b"]))).toBe("drop");
  });

  it("dropsAnInFlightLoadForAnotherMode", () => {
    const prev = loaded("ecmwf", ["a", "b"], { mode: "kiting" });
    expect(loadDecision(prev, DAY, "ecmwf", "kiting", ["a", "b"], pending("ecmwf", ["a", "b"]))).toBe("drop");
    // A site page's own load in flight lands with no mode, which the list doesn't take.
    const sitePage = pending("ecmwf", ["a", "b"], DAY, undefined);
    expect(loadDecision(prev, DAY, "ecmwf", "kiting", ["a", "b"], sitePage)).toBe("drop");
  });

  it("dropsAnInFlightLoadForAnotherDayOrFewerIds", () => {
    const prev = loaded("ecmwf", ["a", "b"]);
    expect(loadDecision(prev, DAY, "ecmwf", "flying", ["a", "b"], pending("ecmwf", ["a", "b"], OTHER_DAY))).toBe(
      "drop",
    );
    expect(loadDecision(prev, DAY, "ecmwf", "flying", ["a", "b"], pending("ecmwf", ["a"]))).toBe("drop");
  });

  it("dropsWhenThereAreNoIdsEvenWithALoadInFlight", () => {
    expect(loadDecision(loaded("ecmwf", ["a"]), DAY, "ecmwf", "flying", undefined, pending("ecmwf", ["a"]))).toBe(
      "drop",
    );
    expect(loadDecision(loaded("ecmwf", ["a"]), DAY, "rrfs", "flying", undefined, undefined)).toBe("drop");
    expect(loadDecision(LOADING, DAY, "ecmwf", "flying", undefined, undefined)).toBe("drop");
  });
});

describe("droppedState", () => {
  it("showsLoadingWhenTheLoadedResultIsForAnotherModel", () => {
    // Undefined ids while routing: the other model's result must not stay on screen.
    expect(droppedState(loaded("ecmwf", ["a"]), DAY, "rrfs", "flying")).toStrictEqual(LOADING);
  });

  it("showsLoadingWhenTheLoadedResultIsForAnotherDay", () => {
    expect(droppedState(loaded("ecmwf", ["a"]), OTHER_DAY, "ecmwf", "flying")).toStrictEqual(LOADING);
  });

  it("showsLoadingWhenTheLoadedResultIsForAnotherMode", () => {
    // Undefined ids while the new mode's sites are routed: the other mode's list must not stay.
    expect(droppedState(loaded("ecmwf", ["a"]), DAY, "ecmwf", "kiting")).toStrictEqual(LOADING);
    expect(droppedState(loaded("ecmwf", ["a"], { mode: undefined }), DAY, "ecmwf", "flying")).toStrictEqual(
      LOADING,
    );
  });

  it("keepsAListsResultWithItsModeOnASitePage", () => {
    const prev = loaded("ecmwf", ["a"], { mode: "kiting", refreshing: true });
    expect(droppedState(prev, DAY, "ecmwf", undefined)).toStrictEqual(loaded("ecmwf", ["a"], { mode: "kiting" }));
  });

  it("keepsTheSameModelsResultWithoutTheRefreshOrItsError", () => {
    const prev = loaded("ecmwf", ["a"], { refreshing: true, refreshError: "offline" });
    const next = droppedState(prev, DAY, "ecmwf", "flying");
    expect(next).toStrictEqual(loaded("ecmwf", ["a"]));
    expect("refreshError" in next).toBe(false);
  });

  it("replacesAFailureWithLoading", () => {
    expect(droppedState(FAILED, DAY, "ecmwf", "flying")).toStrictEqual(LOADING);
  });

  it("leavesLoadingAsItIs", () => {
    expect(droppedState(LOADING, DAY, "rrfs", "flying")).toBe(LOADING);
  });
});

describe("pendingState", () => {
  it("showsLoadingForAnotherModel", () => {
    expect(pendingState(loaded("ecmwf", ["a"]), DAY, "rrfs", "flying")).toStrictEqual(LOADING);
  });

  it("showsLoadingForAnotherMode", () => {
    expect(pendingState(loaded("ecmwf", ["a"]), DAY, "ecmwf", "kiting")).toStrictEqual(LOADING);
    expect(pendingState(loaded("ecmwf", ["a"], { mode: undefined }), DAY, "ecmwf", "kiting")).toStrictEqual(
      LOADING,
    );
  });

  it("showsAListsResultAsRefreshingWithItsModeWhileASitePageLoads", () => {
    const prev = loaded("ecmwf", ["a"], { mode: "kiting" });
    expect(pendingState(prev, DAY, "ecmwf", undefined)).toStrictEqual(
      loaded("ecmwf", ["a"], { mode: "kiting", refreshing: true }),
    );
  });

  it("showsTheSameModelsResultAsRefreshingWithoutAnOldError", () => {
    const prev = loaded("rrfs", ["a"], { refreshError: "offline" });
    const next = pendingState(prev, DAY, "rrfs", "flying");
    expect(next).toStrictEqual(loaded("rrfs", ["a"], { refreshing: true }));
    expect("refreshError" in next).toBe(false);
  });

  it("showsLoadingForAnotherDayOrWithNothingLoaded", () => {
    expect(pendingState(loaded("ecmwf", ["a"]), OTHER_DAY, "ecmwf", "flying")).toStrictEqual(LOADING);
    expect(pendingState(FAILED, DAY, "ecmwf", "flying")).toStrictEqual(LOADING);
    expect(pendingState(LOADING, DAY, "ecmwf", "flying")).toStrictEqual(LOADING);
  });
});

describe("visibleState", () => {
  it("showsTheResultLoadedForThisDayModelAndMode", () => {
    const prev = loaded("ecmwf", ["a"], { mode: "kiting", refreshing: true });
    expect(visibleState(prev, DAY, "ecmwf", "kiting")).toBe(prev);
  });

  it("readsAnotherModesResultAsLoading", () => {
    // The render between a switch and the reload effect.
    expect(visibleState(loaded("ecmwf", ["a"]), DAY, "ecmwf", "kiting")).toStrictEqual(LOADING);
    expect(visibleState(loaded("ecmwf", ["a"], { mode: "kiting" }), DAY, "ecmwf", "flying")).toStrictEqual(LOADING);
    expect(visibleState(loaded("ecmwf", ["a"], { mode: undefined }), DAY, "ecmwf", "flying")).toStrictEqual(LOADING);
  });

  it("readsAnotherDaysOrModelsResultAsLoading", () => {
    expect(visibleState(loaded("ecmwf", ["a"]), OTHER_DAY, "ecmwf", "flying")).toStrictEqual(LOADING);
    expect(visibleState(loaded("ecmwf", ["a"]), undefined, "ecmwf", "flying")).toStrictEqual(LOADING);
    expect(visibleState(loaded("ecmwf", ["a"]), DAY, "rrfs", "flying")).toStrictEqual(LOADING);
  });

  it("showsAnyModesResultOnASitePage", () => {
    for (const mode of ["flying", "kiting", undefined] as const) {
      const prev = loaded("ecmwf", ["a"], { mode });
      expect(visibleState(prev, DAY, "ecmwf", undefined)).toBe(prev);
    }
    expect(visibleState(loaded("ecmwf", ["a"], { mode: "kiting" }), DAY, "rrfs", undefined)).toStrictEqual(LOADING);
  });

  it("leavesLoadingAndFailedAsTheyAre", () => {
    expect(visibleState(LOADING, DAY, "ecmwf", "kiting")).toBe(LOADING);
    expect(visibleState(FAILED, DAY, "ecmwf", "kiting")).toBe(FAILED);
  });
});
