import { describe, expect, it } from "vitest";
import type { ModelName } from "../../src/core/scoring/hourEvaluator";
import type { RecommendationResult } from "../../src/core/recommendation/types";
import type { DayKey } from "../../src/core/time";
import { droppedState, loadDecision, pendingState } from "../../src/ui/useRecommendations";
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
  extra: { requested?: DayKey | undefined; refreshing?: boolean; refreshError?: string } = {},
): RecommendationsState {
  const { refreshing = false, refreshError } = extra;
  // `requested: undefined` is the default day, not "use DAY".
  const requested = "requested" in extra ? extra.requested : DAY;
  const state: RecommendationsState = { status: "loaded", requested, result: result(model, ids), refreshing };
  return refreshError === undefined ? state : { ...state, refreshError };
}

function pending(model: ModelName, ids: readonly string[], day: DayKey | undefined = DAY): PendingLoad {
  return { day, model, ids };
}

const LOADING: RecommendationsState = { status: "loading" };
const FAILED: RecommendationsState = { status: "failed", message: "offline" };

describe("loadDecision", () => {
  it("dropsWhenTheSameDayModelAndIdsAreLoadedAndNothingIsPending", () => {
    const prev = loaded("ecmwf", ["a", "b"]);
    expect(loadDecision(prev, DAY, "ecmwf", ["a", "b"], undefined)).toBe("drop");
    expect(loadDecision(prev, DAY, "ecmwf", ["b"], undefined)).toBe("drop");
  });

  it("keepsAnInFlightLoadThatCoversTheIdsForTheSameDayAndModel", () => {
    const prev = loaded("ecmwf", ["a", "b"]);
    expect(loadDecision(prev, DAY, "ecmwf", ["a", "b"], pending("ecmwf", ["a", "b"]))).toBe("keep");
    // A pending load for more ids still covers.
    expect(loadDecision(prev, DAY, "ecmwf", ["a"], pending("ecmwf", ["a", "b", "c"]))).toBe("keep");
  });

  it("loadsTheSameDayAndIdsForAnotherModel", () => {
    expect(loadDecision(loaded("ecmwf", ["a", "b"]), DAY, "rrfs", ["a", "b"], undefined)).toBe("load");
    expect(loadDecision(loaded("rrfs", ["a", "b"]), DAY, "ecmwf", ["a"], undefined)).toBe("load");
  });

  it("loadsAnotherDay", () => {
    expect(loadDecision(loaded("ecmwf", ["a"]), OTHER_DAY, "ecmwf", ["a"], undefined)).toBe("load");
    expect(loadDecision(loaded("ecmwf", ["a"]), undefined, "ecmwf", ["a"], undefined)).toBe("load");
    expect(loadDecision(loaded("ecmwf", ["a"], { requested: undefined }), DAY, "ecmwf", ["a"], undefined)).toBe(
      "load",
    );
  });

  it("loadsIdsTheResultIsMissing", () => {
    expect(loadDecision(loaded("ecmwf", ["a"]), DAY, "ecmwf", ["a", "b"], undefined)).toBe("load");
    // Even with a covering load in flight: the effect only keeps one when nothing needs loading.
    expect(loadDecision(loaded("ecmwf", ["a"]), DAY, "ecmwf", ["a", "b"], pending("ecmwf", ["a", "b"]))).toBe(
      "load",
    );
  });

  it("loadsFromAFailedOrLoadingState", () => {
    expect(loadDecision(FAILED, DAY, "ecmwf", ["a"], undefined)).toBe("load");
    expect(loadDecision(LOADING, DAY, "ecmwf", ["a"], undefined)).toBe("load");
    expect(loadDecision(LOADING, DAY, "ecmwf", [], undefined)).toBe("load");
  });

  it("dropsAnInFlightLoadForAnotherModel", () => {
    const prev = loaded("ecmwf", ["a", "b"]);
    expect(loadDecision(prev, DAY, "ecmwf", ["a", "b"], pending("rrfs", ["a", "b"]))).toBe("drop");
  });

  it("dropsAnInFlightLoadForAnotherDayOrFewerIds", () => {
    const prev = loaded("ecmwf", ["a", "b"]);
    expect(loadDecision(prev, DAY, "ecmwf", ["a", "b"], pending("ecmwf", ["a", "b"], OTHER_DAY))).toBe("drop");
    expect(loadDecision(prev, DAY, "ecmwf", ["a", "b"], pending("ecmwf", ["a"]))).toBe("drop");
  });

  it("dropsWhenThereAreNoIdsEvenWithALoadInFlight", () => {
    expect(loadDecision(loaded("ecmwf", ["a"]), DAY, "ecmwf", undefined, pending("ecmwf", ["a"]))).toBe("drop");
    expect(loadDecision(loaded("ecmwf", ["a"]), DAY, "rrfs", undefined, undefined)).toBe("drop");
    expect(loadDecision(LOADING, DAY, "ecmwf", undefined, undefined)).toBe("drop");
  });
});

describe("droppedState", () => {
  it("showsLoadingWhenTheLoadedResultIsForAnotherModel", () => {
    // Undefined ids while routing: the other model's result must not stay on screen.
    expect(droppedState(loaded("ecmwf", ["a"]), DAY, "rrfs")).toStrictEqual(LOADING);
  });

  it("showsLoadingWhenTheLoadedResultIsForAnotherDay", () => {
    expect(droppedState(loaded("ecmwf", ["a"]), OTHER_DAY, "ecmwf")).toStrictEqual(LOADING);
  });

  it("keepsTheSameModelsResultWithoutTheRefreshOrItsError", () => {
    const prev = loaded("ecmwf", ["a"], { refreshing: true, refreshError: "offline" });
    const next = droppedState(prev, DAY, "ecmwf");
    expect(next).toStrictEqual(loaded("ecmwf", ["a"]));
    expect("refreshError" in next).toBe(false);
  });

  it("replacesAFailureWithLoading", () => {
    expect(droppedState(FAILED, DAY, "ecmwf")).toStrictEqual(LOADING);
  });

  it("leavesLoadingAsItIs", () => {
    expect(droppedState(LOADING, DAY, "rrfs")).toBe(LOADING);
  });
});

describe("pendingState", () => {
  it("showsLoadingForAnotherModel", () => {
    expect(pendingState(loaded("ecmwf", ["a"]), DAY, "rrfs")).toStrictEqual(LOADING);
  });

  it("showsTheSameModelsResultAsRefreshingWithoutAnOldError", () => {
    const prev = loaded("rrfs", ["a"], { refreshError: "offline" });
    const next = pendingState(prev, DAY, "rrfs");
    expect(next).toStrictEqual(loaded("rrfs", ["a"], { refreshing: true }));
    expect("refreshError" in next).toBe(false);
  });

  it("showsLoadingForAnotherDayOrWithNothingLoaded", () => {
    expect(pendingState(loaded("ecmwf", ["a"]), OTHER_DAY, "ecmwf")).toStrictEqual(LOADING);
    expect(pendingState(FAILED, DAY, "ecmwf")).toStrictEqual(LOADING);
    expect(pendingState(LOADING, DAY, "ecmwf")).toStrictEqual(LOADING);
  });
});
