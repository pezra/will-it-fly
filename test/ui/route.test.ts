import { describe, expect, it } from "vitest";
import { MODEL_NAMES } from "../../src/core/scoring/hourEvaluator";
import type { ModelName } from "../../src/core/scoring/hourEvaluator";
import { listHref, parseRoute, resolveRoute, routeHref, siteHref } from "../../src/ui/route";

const IDS = ["rmhpa/crested-butte", "a?b", "50%/off", "a?b/c%d", "plain", "a b&c=d#e"];

describe("route", () => {
  it("round-trips a site id with slashes", () => {
    const href = siteHref("rmhpa/crested-butte", "ecmwf");
    expect(href).toBe("#/site/rmhpa%2Fcrested-butte?model=ecmwf");
    expect(parseRoute(href)).toEqual({ page: "site", id: "rmhpa/crested-butte", model: "ecmwf" });
  });
  it("round-trips a day", () => {
    expect(listHref("rrfs", "flying", "2026-11-10")).toBe("#/day/2026-11-10?model=rrfs");
    expect(parseRoute("#/day/2026-11-10")).toEqual({ page: "list", mode: "flying", day: "2026-11-10" });
    expect(parseRoute("#/day/2026-11-10/")).toEqual({ page: "list", mode: "flying", day: "2026-11-10" });
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
    expect(listHref("ecmwf", "flying")).toBe("#/?model=ecmwf");
    expect(parseRoute("")).toEqual({ page: "list", mode: "flying" });
    expect(parseRoute("#/")).toEqual({ page: "list", mode: "flying" });
    expect(parseRoute("#/site/%E0%A4%A")).toEqual({ page: "list", mode: "flying" });
    expect(parseRoute("#/day/2026-02-30")).toEqual({ page: "list", mode: "flying" });
    expect(parseRoute("#/day/tomorrow")).toEqual({ page: "list", mode: "flying" });
    expect(parseRoute("#/day/2026-02-30/site/x")).toEqual({ page: "list", mode: "flying" });
    expect(parseRoute("#/elsewhere")).toEqual({ page: "list", mode: "flying" });
  });
  it("round-trips every model, with and without a day, for lists and sites", () => {
    for (const model of MODEL_NAMES) {
      for (const mode of ["flying", "kiting"] as const) {
        expect(parseRoute(listHref(model, mode))).toEqual({ page: "list", mode, model });
        expect(parseRoute(listHref(model, mode, "2026-11-10"))).toEqual({
          page: "list",
          mode,
          day: "2026-11-10",
          model,
        });
      }
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
      expect(parseRoute(hash)).toEqual({ page: "list", mode: "flying" });
      expect(parseRoute(hash).model).toBeUndefined();
    }
    expect(parseRoute("#/site/x")).toEqual({ page: "site", id: "x" });
    expect(parseRoute("#/site/x?model=nope").model).toBeUndefined();
  });
  it("keeps the link's model when the path is not a route", () => {
    expect(parseRoute("#/elsewhere?model=rrfs")).toEqual({ page: "list", mode: "flying", model: "rrfs" });
    expect(parseRoute("#/day/2026-02-30?model=rrfs")).toEqual({ page: "list", mode: "flying", model: "rrfs" });
    expect(parseRoute("#/site/%E0%A4%A?model=rrfs")).toEqual({ page: "list", mode: "flying", model: "rrfs" });
  });
  it("reads the model from among other parameters", () => {
    expect(parseRoute("#/?x=1&model=rrfs&y=2")).toEqual({ page: "list", mode: "flying", model: "rrfs" });
  });
});

describe("kite routes", () => {
  it("reads #/kite and #/kite/ as the Kite list for the default day", () => {
    expect(parseRoute("#/kite")).toEqual({ page: "list", mode: "kiting" });
    expect(parseRoute("#/kite/")).toEqual({ page: "list", mode: "kiting" });
  });
  it("reads #/kite/<date> as the Kite list for that day", () => {
    expect(parseRoute("#/kite/2026-11-12")).toEqual({ page: "list", mode: "kiting", day: "2026-11-12" });
    expect(parseRoute("#/kite/2026-11-12/")).toEqual({ page: "list", mode: "kiting", day: "2026-11-12" });
  });
  it("falls back to the Kite list for the default day when the date is bad", () => {
    expect(parseRoute("#/kite/nope")).toEqual({ page: "list", mode: "kiting" });
    expect(parseRoute("#/kite/2026-02-30")).toEqual({ page: "list", mode: "kiting" });
    expect(parseRoute("#/kite/nope?model=rrfs")).toEqual({ page: "list", mode: "kiting", model: "rrfs" });
  });
  it("reads the model from the query", () => {
    expect(parseRoute("#/kite?model=rrfs")).toEqual({ page: "list", mode: "kiting", model: "rrfs" });
    expect(parseRoute("#/kite/2026-11-12?model=rrfs")).toEqual({
      page: "list",
      mode: "kiting",
      day: "2026-11-12",
      model: "rrfs",
    });
    expect(parseRoute("#/kite?model=foo").model).toBeUndefined();
  });
  it("does not take other paths that start with kite", () => {
    expect(parseRoute("#/kites")).toEqual({ page: "list", mode: "flying" });
    expect(parseRoute("#/kite/2026-11-12/site/x")).toEqual({ page: "list", mode: "flying" });
    expect(parseRoute("#/day/2026-11-12/kite")).toEqual({ page: "list", mode: "flying" });
  });
  it("gives the Kite hrefs", () => {
    expect(listHref("ecmwf", "kiting")).toBe("#/kite?model=ecmwf");
    expect(listHref("rrfs", "kiting", "2026-11-12")).toBe("#/kite/2026-11-12?model=rrfs");
  });
  it("keeps site routes without a mode", () => {
    expect(parseRoute("#/site/a%2Fb")).toEqual({ page: "site", id: "a/b" });
    expect(parseRoute("#/day/2026-11-12/site/a%2Fb")).toEqual({ page: "site", id: "a/b", day: "2026-11-12" });
    expect(parseRoute("#/site/a%2Fb")).not.toHaveProperty("mode");
  });
});

describe("routeHref", () => {
  it("gives the route's page and day with the given model, ignoring the route's own", () => {
    expect(routeHref({ page: "list", mode: "flying" }, "rrfs")).toBe("#/?model=rrfs");
    expect(routeHref({ page: "list", mode: "flying", day: "2026-11-10", model: "ecmwf" }, "rrfs")).toBe(
      "#/day/2026-11-10?model=rrfs",
    );
    expect(routeHref({ page: "list", mode: "kiting", model: "ecmwf" }, "rrfs")).toBe("#/kite?model=rrfs");
    expect(routeHref({ page: "list", mode: "kiting", day: "2026-11-10", model: "ecmwf" }, "rrfs")).toBe(
      "#/kite/2026-11-10?model=rrfs",
    );
    expect(routeHref({ page: "site", id: "a/b", day: "2026-11-10", model: "rrfs" }, "ecmwf")).toBe(
      "#/day/2026-11-10/site/a%2Fb?model=ecmwf",
    );
  });
});

/** The hash `resolveRoute` rewrites to, or undefined when it's already canonical. */
const canonicalHash = (hash: string, defaultModel: ModelName): string | undefined =>
  resolveRoute(hash, defaultModel).rewrite;

describe("resolveRoute's rewrite", () => {
  // It takes no store, so a shared link can't change the saved default; only `switchModel` writes it.
  it("adds the default model to a hash with none", () => {
    expect(canonicalHash("#/", "ecmwf")).toBe("#/?model=ecmwf");
    expect(canonicalHash("", "ecmwf")).toBe("#/?model=ecmwf");
    expect(canonicalHash("", "rrfs")).toBe("#/?model=rrfs");
    expect(canonicalHash("#/site/x", "rrfs")).toBe("#/site/x?model=rrfs");
    expect(canonicalHash("#/kite", "ecmwf")).toBe("#/kite?model=ecmwf");
    expect(canonicalHash("#/kite/2026-11-12", "rrfs")).toBe("#/kite/2026-11-12?model=rrfs");
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
    expect(canonicalHash("#/kite/?model=rrfs", "ecmwf")).toBe("#/kite?model=rrfs");
    expect(canonicalHash("#/kite/2026-11-12/?model=rrfs", "ecmwf")).toBe("#/kite/2026-11-12?model=rrfs");
    expect(canonicalHash("#/kite/nope?model=rrfs", "ecmwf")).toBe("#/kite?model=rrfs");
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
      "#/kite",
      "#/kite/",
      "#/kite/2026-11-12/?model=rrfs",
      "#/kite/nope",
      "#/kite?model=foo",
    ];
    for (const h of inputs) {
      for (const d of MODEL_NAMES) {
        expect(canonicalHash(canonicalHash(h, d) ?? h, d), `${h} with ${d}`).toBeUndefined();
      }
    }
  });
});

describe("resolveRoute", () => {
  it("gives a missing or bad model the default, with a rewrite", () => {
    expect(resolveRoute("#/", "rrfs")).toEqual({
      route: { page: "list", mode: "flying", model: "rrfs" },
      rewrite: "#/?model=rrfs",
    });
    expect(resolveRoute("", "ecmwf")).toEqual({
      route: { page: "list", mode: "flying", model: "ecmwf" },
      rewrite: "#/?model=ecmwf",
    });
    expect(resolveRoute("#/kite", "ecmwf")).toEqual({
      route: { page: "list", mode: "kiting", model: "ecmwf" },
      rewrite: "#/kite?model=ecmwf",
    });
    expect(resolveRoute("#/day/2026-11-11/site/a%2Fb?model=RRFS", "rrfs")).toEqual({
      route: { page: "site", id: "a/b", day: "2026-11-11", model: "rrfs" },
      rewrite: "#/day/2026-11-11/site/a%2Fb?model=rrfs",
    });
  });
  it("keeps the link's model over the default", () => {
    expect(resolveRoute("#/elsewhere?model=rrfs", "ecmwf")).toEqual({
      route: { page: "list", mode: "flying", model: "rrfs" },
      rewrite: "#/?model=rrfs",
    });
    expect(resolveRoute("#/site/x?model=ecmwf&x=1", "rrfs")).toEqual({
      route: { page: "site", id: "x", model: "ecmwf" },
      rewrite: "#/site/x?model=ecmwf",
    });
  });
  it("gives no rewrite for a canonical hash", () => {
    const resolved = resolveRoute("#/day/2026-11-11?model=rrfs", "ecmwf");
    expect(resolved).toEqual({ route: { page: "list", mode: "flying", day: "2026-11-11", model: "rrfs" } });
    expect("rewrite" in resolved).toBe(false);
    const kite = resolveRoute("#/kite/2026-11-11?model=rrfs", "ecmwf");
    expect(kite).toEqual({ route: { page: "list", mode: "kiting", day: "2026-11-11", model: "rrfs" } });
    expect("rewrite" in kite).toBe(false);
  });
  it("always gives a route with a model, the one its rewrite names", () => {
    const hashes = [
      "",
      "#/",
      "#/?model=",
      "#/site/x",
      "#/day/2026-02-30",
      "#/site/%E0%A4%A",
      "#/?model=rrfs",
      "#/kite",
      "#/kite/nope",
      "#/kite/2026-11-12?model=rrfs",
    ];
    for (const hash of hashes) {
      for (const d of MODEL_NAMES) {
        const { route, rewrite } = resolveRoute(hash, d);
        expect(route.model, `${hash} with ${d}`).toBeDefined();
        expect(route).toEqual({ ...parseRoute(rewrite ?? hash), model: route.model });
        expect(parseRoute(rewrite ?? hash).model).toBe(route.model);
      }
    }
  });
});
