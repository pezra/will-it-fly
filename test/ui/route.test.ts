import { describe, expect, it } from "vitest";
import { listHref, parseRoute, siteHref } from "../../src/ui/route";

describe("route", () => {
  it("round-trips a site id with slashes", () => {
    const href = siteHref("rmhpa/crested-butte");
    expect(href).toBe("#/site/rmhpa%2Fcrested-butte");
    expect(parseRoute(href)).toEqual({ page: "site", id: "rmhpa/crested-butte" });
  });
  it("round-trips a day", () => {
    expect(listHref("2026-11-10")).toBe("#/day/2026-11-10");
    expect(parseRoute("#/day/2026-11-10")).toEqual({ page: "list", day: "2026-11-10" });
    expect(parseRoute("#/day/2026-11-10/")).toEqual({ page: "list", day: "2026-11-10" });
    const href = siteHref("rmhpa/crested-butte", "2026-11-10");
    expect(href).toBe("#/day/2026-11-10/site/rmhpa%2Fcrested-butte");
    expect(parseRoute(href)).toEqual({ page: "site", id: "rmhpa/crested-butte", day: "2026-11-10" });
  });
  it("falls back to the default day's list", () => {
    expect(listHref()).toBe("#/");
    expect(parseRoute("")).toEqual({ page: "list" });
    expect(parseRoute("#/")).toEqual({ page: "list" });
    expect(parseRoute("#/site/%E0%A4%A")).toEqual({ page: "list" });
    expect(parseRoute("#/day/2026-02-30")).toEqual({ page: "list" });
    expect(parseRoute("#/day/tomorrow")).toEqual({ page: "list" });
    expect(parseRoute("#/day/2026-02-30/site/x")).toEqual({ page: "list" });
    expect(parseRoute("#/elsewhere")).toEqual({ page: "list" });
  });
});
