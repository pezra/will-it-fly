import { describe, expect, it } from "vitest";
import { parseRoute, siteHref } from "../../src/ui/route";

describe("route", () => {
  it("round-trips a site id with slashes", () => {
    const href = siteHref("rmhpa/crested-butte");
    expect(href).toBe("#/site/rmhpa%2Fcrested-butte");
    expect(parseRoute(href)).toEqual({ page: "site", id: "rmhpa/crested-butte" });
  });
  it("falls back to the list", () => {
    expect(parseRoute("")).toEqual({ page: "list" });
    expect(parseRoute("#/")).toEqual({ page: "list" });
    expect(parseRoute("#/site/%E0%A4%A")).toEqual({ page: "list" });
  });
});
