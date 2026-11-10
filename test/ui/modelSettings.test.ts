import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDefaultModel, MODEL_SETTINGS_KEY, saveDefaultModel, switchModel } from "../../src/ui/modelSettings";
import { mapStore } from "../support/builders";

afterEach(() => vi.restoreAllMocks());

describe("loadDefaultModel and saveDefaultModel", () => {
  it("is ECMWF when nothing is saved", () => {
    expect(loadDefaultModel(mapStore())).toBe("ecmwf");
  });

  it("round-trips each model", () => {
    for (const model of ["ecmwf", "rrfs"] as const) {
      const store = mapStore();
      saveDefaultModel(store, model);
      expect(loadDefaultModel(store)).toBe(model);
    }
  });

  it("writes JSON under the literal versioned key", () => {
    const map = new Map<string, string>();
    saveDefaultModel(mapStore(map), "rrfs");
    expect(MODEL_SETTINGS_KEY).toBe("willItFly.model.v1");
    expect(map.get("willItFly.model.v1")).toBe('"rrfs"');
  });

  it.each([
    ["unquoted", "rrfs"],
    ["upper case", '"RRFS"'],
    ["an unknown model", '"gfs"'],
    ["null", "null"],
    ["a number", "42"],
    ["an array", "[]"],
    ["an object", '{"model":"rrfs"}'],
    ["an empty string", '""'],
    ["empty text", ""],
  ])("reads %s as ECMWF", (_name, text) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadDefaultModel(mapStore(new Map([[MODEL_SETTINGS_KEY, text]])))).toBe("ecmwf");
  });

  it("reads ECMWF and warns when reading the store throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = {
      get: () => {
        throw new Error("blocked");
      },
      set: () => {},
    };
    expect(loadDefaultModel(store)).toBe("ecmwf");
    expect(warn).toHaveBeenCalled();
  });

  it("does not throw when writing the store throws, and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = {
      get: () => undefined,
      set: () => {
        throw new Error("full");
      },
    };
    expect(() => saveDefaultModel(store, "rrfs")).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe("switchModel", () => {
  it("saves the model and returns the route's hash with it", () => {
    const store = mapStore();
    const hash = switchModel(store, { page: "list", model: "ecmwf" }, "rrfs");
    expect(hash).toBe("#/?model=rrfs");
    expect(loadDefaultModel(store)).toBe("rrfs");
  });

  it("keeps the page and day of a site route", () => {
    const store = mapStore();
    const hash = switchModel(store, { page: "site", id: "a/b", day: "2026-11-10", model: "rrfs" }, "ecmwf");
    expect(hash).toBe("#/day/2026-11-10/site/a%2Fb?model=ecmwf");
    expect(loadDefaultModel(store)).toBe("ecmwf");
  });

  it("still returns the hash when the save fails", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = {
      get: () => undefined,
      set: () => {
        throw new Error("full");
      },
    };
    expect(switchModel(store, { page: "list" }, "rrfs")).toBe("#/?model=rrfs");
  });
});
