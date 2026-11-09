import { describe, expect, it } from "vitest";
import { MODEL_NAMES } from "../../src/core/scoring/hourEvaluator";
import { canonicalHash, listHref, parseRoute, routeHref, siteHref } from "../../src/ui/route";

const IDS = ["rmhpa/crested-butte", "a?b", "50%/off", "a?b/c%d", "plain", "a b&c=d#e"];

describe("route", () => {
  it("round-trips a site id with slashes", () => {
    const href = siteHref("rmhpa/crested-butte", "ecmwf");
    expect(href).toBe("#/site/rmhpa%2Fcrested-butte?model=ecmwf");
    expect(parseRoute(href)).toEqual({ page: "site", id: "rmhpa/crested-butte", model: "ecmwf" });
  });
  it("round-trips a day", () => {
    expect(listHref("rrfs", "2026-11-10")).toBe("#/day/2026-11-10?model=rrfs");
    expect(parseRoute("#/day/2026-11-10")).toEqual({ page: "list", day: "2026-11-10" });
    expect(parseRoute("#/day/2026-11-10/")).toEqual({ page: "list", day: "2026-11-10" });
    const href = siteHref("rmhpa/crested-butte", "rrfs", "2026-11-10");
    expect(href).toBe("#/day/2026-11-10/site/rmhpa%2Fcrested-butte?model=rrfs");
    expect(parseRoute(href)).toEqual({
      page: "site",
      id: "rmhpa/crested-butte",
      day: "2026-11-10",
      model: "rrfs",
    });
  });
  it("falls back to the default day's list", () => {
    expect(listHref("ecmwf")).toBe("#/?model=ecmwf");
    expect(parseRoute("")).toEqual({ page: "list" });
    expect(parseRoute("#/")).toEqual({ page: "list" });
    expect(parseRoute("#/site/%E0%A4%A")).toEqual({ page: "list" });
    expect(parseRoute("#/day/2026-02-30")).toEqual({ page: "list" });
    expect(parseRoute("#/day/tomorrow")).toEqual({ page: "list" });
    expect(parseRoute("#/day/2026-02-30/site/x")).toEqual({ page: "list" });
    expect(parseRoute("#/elsewhere")).toEqual({ page: "list" });
  });
  it("round-trips every model, with and without a day, for lists and sites", () => {
    for (const model of MODEL_NAMES) {
      expect(parseRoute(listHref(model))).toEqual({ page: "list", model });
      expect(parseRoute(listHref(model, "2026-11-10"))).toEqual({ page: "list", day: "2026-11-10", model });
      for (const id of IDS) {
        expect(parseRoute(siteHref(id, model))).toEqual({ page: "site", id, model });
        expect(parseRoute(siteHref(id, model, "2026-11-10"))).toEqual({
          page: "site",
          id,
          day: "2026-11-10",
          model,
        });
      }
    }
  });
  it("reads a bad or missing model as undefined", () => {
    for (const hash of ["#/?model=RRFS", "#/?model=", "#/?model=foo", "#/?model", "#/?x=1", "#/?"]) {
      expect(parseRoute(hash)).toEqual({ page: "list" });
      expect(parseRoute(hash).model).toBeUndefined();
    }
    expect(parseRoute("#/site/x")).toEqual({ page: "site", id: "x" });
    expect(parseRoute("#/site/x?model=nope").model).toBeUndefined();
  });
  it("keeps the link's model when the path is not a route", () => {
    expect(parseRoute("#/elsewhere?model=rrfs")).toEqual({ page: "list", model: "rrfs" });
    expect(parseRoute("#/day/2026-02-30?model=rrfs")).toEqual({ page: "list", model: "rrfs" });
    expect(parseRoute("#/site/%E0%A4%A?model=rrfs")).toEqual({ page: "list", model: "rrfs" });
  });
  it("reads the model from among other parameters", () => {
    expect(parseRoute("#/?x=1&model=rrfs&y=2")).toEqual({ page: "list", model: "rrfs" });
  });
});

describe("routeHref", () => {
  it("gives the route's page and day with the given model, ignoring the route's own", () => {
    expect(routeHref({ page: "list" }, "rrfs")).toBe("#/?model=rrfs");
    expect(routeHref({ page: "list", day: "2026-11-10", model: "ecmwf" }, "rrfs")).toBe(
      "#/day/2026-11-10?model=rrfs",
    );
    expect(routeHref({ page: "site", id: "a/b", day: "2026-11-10", model: "rrfs" }, "ecmwf")).toBe(
      "#/day/2026-11-10/site/a%2Fb?model=ecmwf",
    );
  });
});

describe("canonicalHash", () => {
  // It takes no store, so a shared link can't change the saved default; only `switchModel` writes it.
  it("adds the default model to a hash with none", () => {
    expect(canonicalHash("#/", "ecmwf")).toBe("#/?model=ecmwf");
    expect(canonicalHash("", "ecmwf")).toBe("#/?model=ecmwf");
    expect(canonicalHash("", "rrfs")).toBe("#/?model=rrfs");
    expect(canonicalHash("#/site/x", "rrfs")).toBe("#/site/x?model=rrfs");
  });
  it("leaves a hash that names a model alone", () => {
    expect(canonicalHash("#/?model=rrfs", "ecmwf")).toBeUndefined();
    expect(canonicalHash("#/?model=ecmwf", "rrfs")).toBeUndefined();
  });
  it("replaces a bad model with the default", () => {
    expect(canonicalHash("#/day/2026-11-11?model=foo", "rrfs")).toBe("#/day/2026-11-11?model=rrfs");
    expect(canonicalHash("#/?model=RRFS", "ecmwf")).toBe("#/?model=ecmwf");
    expect(canonicalHash("#/?model=", "ecmwf")).toBe("#/?model=ecmwf");
  });
  it("drops unknown parameters", () => {
    expect(canonicalHash("#/?model=rrfs&x=1", "ecmwf")).toBe("#/?model=rrfs");
    expect(canonicalHash("#/?x=1", "ecmwf")).toBe("#/?model=ecmwf");
  });
  it("normalizes the path", () => {
    expect(canonicalHash("#/day/2026-11-11/", "ecmwf")).toBe("#/day/2026-11-11?model=ecmwf");
    expect(canonicalHash("#/day/2026-11-11/?model=rrfs", "ecmwf")).toBe("#/day/2026-11-11?model=rrfs");
    expect(canonicalHash("#/elsewhere?model=rrfs", "ecmwf")).toBe("#/?model=rrfs");
    expect(canonicalHash("#/site/a%2fb?model=rrfs", "ecmwf")).toBe("#/site/a%2Fb?model=rrfs");
  });
  it("keeps an id with ?, / and % intact", () => {
    for (const model of MODEL_NAMES) {
      const href = siteHref("a?b/c%d", model, "2026-11-11");
      expect(canonicalHash(href, "ecmwf")).toBeUndefined();
      expect(canonicalHash(href.slice(0, href.indexOf("?")), model)).toBe(href);
    }
  });
  it("is idempotent for every input", () => {
    const inputs = [
      "#/",
      "",
      "#/?model=rrfs",
      "#/?model=ecmwf",
      "#/day/2026-11-11?model=foo",
      "#/?model=rrfs&x=1",
      "#/day/2026-11-11/",
      "#/day/2026-11-11/site/a%3Fb%2Fc%25d",
      "#/site/a%3Fb%2Fc%25d?model=rrfs",
      "#/site/a?b/c%d",
      "#/site/a%2fb",
      "#/site/%E0%A4%A",
      "#/elsewhere?model=rrfs",
      "#/day/2026-02-30?model=rrfs",
      "#/?model=",
      "#/?model=RRFS",
      "#/site/x",
    ];
    for (const h of inputs) {
      for (const d of MODEL_NAMES) {
        expect(canonicalHash(canonicalHash(h, d) ?? h, d), `${h} with ${d}`).toBeUndefined();
      }
    }
  });
});
