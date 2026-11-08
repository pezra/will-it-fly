import { describe, expect, it } from "vitest";
import { DEFAULT_WIND_LIMITS, effectiveLimits } from "../../../src/core/sites/site";
import { testLaunch, testSite } from "../../support/builders";

describe("effectiveLimits", () => {
  it("uses the site limits when the launch has none", () => {
    const site = testSite({ limits: { minMph: 3, idealMph: 8, maxMph: 14, gustFactorMph: 4 } });
    expect(effectiveLimits(site, testLaunch())).toEqual({ minMph: 3, idealMph: 8, maxMph: 14, gustFactorMph: 4 });
  });

  it("launch limits override the site limits as a whole", () => {
    const site = testSite({ limits: { minMph: 3, idealMph: 8, maxMph: 14, gustFactorMph: 4 } });
    const launch = testLaunch({ limits: { minMph: 0, maxMph: 12 } });
    expect(effectiveLimits(site, launch)).toEqual({
      minMph: 0,
      maxMph: 12,
      gustFactorMph: DEFAULT_WIND_LIMITS.gustFactorMph,
    });
  });

  it("a missing gust factor falls back to the default", () => {
    const site = testSite({ limits: { minMph: 0, maxMph: 15 } });
    expect(effectiveLimits(site, testLaunch()).gustFactorMph).toBe(5);
  });
});
