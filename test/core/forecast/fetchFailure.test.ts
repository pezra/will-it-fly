import { describe, expect, it } from "vitest";
import { fetchFailureKind } from "../../../src/core/forecast/fetchFailure";
import { OpenMeteoError } from "../../../src/core/forecast/openMeteoClient";

describe("fetchFailureKind", () => {
  it("callsAn429RateLimited", () => {
    expect(fetchFailureKind(new OpenMeteoError("http", "slow down", { status: 429 }))).toBe("rateLimited");
  });

  it("callsA5xxServer", () => {
    expect(fetchFailureKind(new OpenMeteoError("http", "boom", { status: 500 }))).toBe("server");
    expect(fetchFailureKind(new OpenMeteoError("http", "down", { status: 503 }))).toBe("server");
  });

  it("callsOtherOpenMeteoErrorsOther", () => {
    expect(fetchFailureKind(new OpenMeteoError("http", "missing", { status: 404 }))).toBe("other");
    expect(fetchFailureKind(new OpenMeteoError("api", "bad param"))).toBe("other");
    expect(fetchFailureKind(new OpenMeteoError("unexpectedShape", "no hours"))).toBe("other");
  });

  it("callsTimeoutsAndFetchFailuresNetwork", () => {
    expect(fetchFailureKind(new DOMException("x", "AbortError"))).toBe("network");
    expect(fetchFailureKind(new DOMException("x", "TimeoutError"))).toBe("network");
    expect(fetchFailureKind(new TypeError("Load failed"))).toBe("network");
    expect(fetchFailureKind({ name: "AbortError" })).toBe("network");
  });

  it("callsAnythingElseOther", () => {
    expect(fetchFailureKind(new Error("x"))).toBe("other");
    expect(fetchFailureKind("boom")).toBe("other");
    expect(fetchFailureKind(undefined)).toBe("other");
  });
});
