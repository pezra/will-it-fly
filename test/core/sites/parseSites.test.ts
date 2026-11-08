import { describe, expect, it } from "vitest";
import sample from "../../fixtures/sites-sample.json?raw";
import { DEFAULT_WIND_LIMITS, elevationM } from "../../../src/core/sites/site";
import { bundledSiteProvider } from "../../../src/core/sites/siteProvider";
import { parseSites, SiteDataError } from "../../../src/core/sites/parseSites";

const sampleJson: unknown = JSON.parse(sample);

function provider() {
  return bundledSiteProvider(sampleJson);
}

type Path = (string | number)[];

/** A deep copy of the sample with one value set (or deleted when `value` is undefined). */
function broken(path: Path, value?: unknown): unknown {
  const copy: unknown = JSON.parse(sample);
  let node = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return copy;
}

describe("bundledSiteProvider", () => {
  it("decodesSampleSites", async () => {
    const sites = await provider().sites();
    expect(sites.length).toBe(2);
    const glenwood = sites.find((s) => s.id === "rmhpa/glenwood-lookout");
    expect(glenwood).toBeDefined();
    if (glenwood === undefined) return;
    expect(glenwood.status).toEqual({ state: "open" });
    expect(glenwood.launches.length).toBe(2);
    expect(glenwood.launches.map((l) => l.id)).toEqual([
      "rmhpa/glenwood-lookout/north",
      "rmhpa/glenwood-lookout/south",
    ]);
    expect(glenwood.limits.idealMph).toBe(8);
    const [north, south] = glenwood.launches;
    expect(north?.limits).toBeUndefined();
    expect(south?.limits).toStrictEqual({ minMph: 3, maxMph: 12 });
    expect(north?.directions.ok).toEqual([{ from: 330, to: 30 }]);
    expect(Math.abs(elevationM(north!) - 2400.3)).toBeLessThan(0.1);
  });

  it("decodesClosedSite", async () => {
    const sites = await provider().sites();
    const wolcott = sites.find((s) => s.id === "rmhpa/wolcott");
    expect(wolcott?.status).toEqual({ state: "closed", reason: "CURRENTLY CLOSED" });
    expect(wolcott?.launches[0]?.directions.ok).toEqual([]);
  });

  it("missingResourceThrows (a non-catalog value rejects with SiteDataError)", async () => {
    await expect(bundledSiteProvider("nope").sites()).rejects.toBeInstanceOf(SiteDataError);
  });

  it("defaultLimits", () => {
    expect(DEFAULT_WIND_LIMITS).toStrictEqual({ minMph: 0, maxMph: 15, gustFactorMph: 5 });
    expect(DEFAULT_WIND_LIMITS.idealMph).toBeUndefined();
  });
});

describe("parseSites", () => {
  it("rejects a missing launches", () => {
    const j = broken(["sites", 0, "launches"]);
    expect(() => parseSites(j)).toThrow(SiteDataError);
    expect(() => parseSites(j)).toThrow(/launches/);
  });

  it("rejects a bad status state", () => {
    const j = broken(["sites", 0, "status"], { state: "ajar" });
    expect(() => parseSites(j)).toThrow(/status/);
    expect(() => parseSites(j)).toThrow(/ajar/);
  });

  it("rejects a non-numeric arc bound", () => {
    const j = broken(["sites", 0, "launches", 0, "directions", "ok", 0, "to"], "north");
    expect(() => parseSites(j)).toThrow(/directions\.ok\[0\]\.to/);
  });

  it("names the record in the message", () => {
    const j = broken(["sites", 1, "name"]);
    expect(() => parseSites(j)).toThrow(/rmhpa\/wolcott/);
  });

  it("rejects a malformed top level", () => {
    expect(() => parseSites(null)).toThrow(SiteDataError);
    expect(() => parseSites({ sites: "x" })).toThrow(/sites/);
    expect(() => parseSites({ curatedOn: 5, sites: [] })).toThrow(/curatedOn/);
  });

  it("defaults a closed status without a reason to Closed", () => {
    const j = broken(["sites", 1, "status"], { state: "closed" });
    expect(parseSites(j)[1]?.status).toEqual({ state: "closed", reason: "Closed" });
  });

  it("treats null optionals as absent", () => {
    const j = broken(["sites", 0, "notes"], null);
    const k = broken(["sites", 0, "limits", "idealMph"], null);
    expect("notes" in parseSites(j)[0]!).toBe(false);
    expect("idealMph" in parseSites(k)[0]!.limits).toBe(false);
  });

  it("drops JSON-only fields", () => {
    const north = parseSites(sampleJson)[0]?.launches[0];
    expect(north).toStrictEqual({
      id: "rmhpa/glenwood-lookout/north",
      name: "North Launch",
      coordinate: { latitude: 39.5428, longitude: -107.3003 },
      elevationFt: 7875,
      directions: { ok: [{ from: 330, to: 30 }], ideal: [{ from: 350, to: 10 }] },
    });
  });

  it("does not mutate its input", () => {
    const before = sample;
    parseSites(sampleJson);
    expect(JSON.stringify(sampleJson)).toBe(JSON.stringify(JSON.parse(before)));
  });

  it("decodesSoaringAndXc", () => {
    const sites = parseSites({
      sites: [
        {
          ...(sampleJson as { sites: Record<string, unknown>[] }).sites[0],
          soaring: { notes: "n", minMph: 9, launchIds: ["a"] },
          xc: { notes: "x" },
        },
      ],
    });
    expect(sites[0]?.soaring).toEqual({ notes: "n", minMph: 9, launchIds: ["a"] });
    expect(sites[0]?.xc).toEqual({ notes: "x" });
    expect(() => parseSites(broken(["sites", 0, "soaring"], {}))).toThrow(SiteDataError);
  });
});
