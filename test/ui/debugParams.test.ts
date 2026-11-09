import { describe, expect, it } from "vitest";
import { parseDebugParams } from "../../src/ui/debugParams";

describe("parseDebugParams", () => {
  it("is empty with no params", () => {
    expect(parseDebugParams("")).toEqual({});
  });
  it("reads routeBase", () => {
    expect(parseDebugParams("?routeBase=http://127.0.0.1:9")).toEqual({
      routeBaseURL: "http://127.0.0.1:9",
    });
  });
  it("ignores an empty routeBase or base", () => {
    expect(parseDebugParams("?routeBase=&base=")).toEqual({});
  });
  it("keeps base and routeBase separate", () => {
    expect(parseDebugParams("?base=http://a.test&routeBase=http://b.test")).toEqual({
      baseURL: "http://a.test",
      routeBaseURL: "http://b.test",
    });
  });
  it("reads now as an ISO time and ignores a bad one", () => {
    expect(parseDebugParams("?now=2026-11-08T15:00:00Z")).toEqual({
      now: Date.parse("2026-11-08T15:00:00Z"),
    });
    expect(parseDebugParams("?now=yesterday")).toEqual({});
  });
  it("reads a fake location only when both parts are numbers", () => {
    expect(parseDebugParams("?lat=40.015&lon=-105.27")).toEqual({
      location: { latitude: 40.015, longitude: -105.27 },
    });
    expect(parseDebugParams("?lat=40.015")).toEqual({});
    expect(parseDebugParams("?lat=&lon=-105.27")).toEqual({});
    expect(parseDebugParams("?lat=north&lon=-105.27")).toEqual({});
  });
  it("reads nolocation", () => {
    expect(parseDebugParams("?nolocation")).toEqual({ noLocation: true });
  });
});
