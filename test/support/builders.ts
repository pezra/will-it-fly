import type { RemovableStore } from "../../src/core/keyValueStore";
import type { Reason, ReasonKind } from "../../src/core/scoring/hourEvaluator";
import type { Launch, Site, WindLimits } from "../../src/core/sites/site";
import { METERS_PER_FOOT } from "../../src/core/units";
import { PERFECT_LAUNCH_ELEVATION_M } from "./hourBuilder";

/** Limits that put the perfect hour's 10 mph at ideal, with a min > 0. */
export const TEST_LIMITS: Readonly<WindLimits> = Object.freeze({
  minMph: 5,
  idealMph: 10,
  maxMph: 18,
  gustFactorMph: 6,
});

/** A fresh launch at the perfect-hour elevation with no curated directions, plus overrides. */
export function testLaunch(overrides: Partial<Launch> = {}): Launch {
  return {
    id: "test/site/launch",
    name: "Test launch",
    coordinate: { latitude: 39.5, longitude: -106 },
    elevationFt: PERFECT_LAUNCH_ELEVATION_M / METERS_PER_FOOT,
    directions: { ok: [], ideal: [] },
    ...overrides,
  };
}

/** A fresh open site with one `testLaunch()` and `TEST_LIMITS`, plus overrides. */
export function testSite(overrides: Partial<Site> = {}): Site {
  return {
    id: "test/site",
    name: "Test site",
    kind: "flying",
    sourceURL: "https://example.com",
    rating: "P2",
    status: { state: "open" },
    launches: [testLaunch()],
    limits: { ...TEST_LIMITS },
    ...overrides,
  };
}

/** A `RemovableStore` over a `Map` (a new one unless given). */
export function mapStore(map = new Map<string, string>()): RemovableStore {
  return {
    get: (k) => map.get(k),
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
}

/** The reason kinds of a result, in order. */
export function kinds(r: { reasons: readonly Reason[] }): ReasonKind[] {
  return r.reasons.map((x) => x.kind);
}
