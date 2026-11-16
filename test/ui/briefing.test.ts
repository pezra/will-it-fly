import { describe, expect, it } from "vitest";
import { testLaunch, testSite } from "../support/builders";
import type { Site } from "../../src/core/sites/site";
import { briefingLinks, briefingPrompt, copyPrompt, showsBriefing } from "../../src/ui/briefing";

const lookout = testLaunch({
  name: "Lookout",
  coordinate: { latitude: 39.12345, longitude: -105.6789 },
  elevationFt: 7500,
  directions: { ok: [{ from: 250, to: 310 }], ideal: [{ from: 270, to: 290 }] },
});
const meadow = testLaunch({
  name: "Meadow",
  limits: { minMph: 8, maxMph: 20, gustFactorMph: 5 },
  directions: { ok: [], ideal: [] },
});
const site: Site = testSite({
  name: "Fixture Peak",
  sourceURL: "https://example.com/fixture-peak",
  rating: "P9",
  launches: [lookout, meadow],
  notes: "Park at the lower lot.",
  soaring: { notes: "Ridge works in west wind." },
  xc: { notes: "Fly north along the range." },
});
const prompt = briefingPrompt(site, "2026-11-16");

describe("briefingPrompt", () => {
  it("names the day and the site", () => {
    expect(prompt).toContain("Monday, November 16, 2026");
    expect(prompt).toContain("Fixture Peak");
    expect(prompt).toContain(site.sourceURL);
  });

  it("words a launch line from the site page's labels", () => {
    expect(prompt).toContain(
      "- Lookout: 39.12345, -105.67890, 7,500 ft. Works best 270–290° (W–WNW). OK 250–310° (WSW–NW). Wind limits 5–18 mph, ideal 10 mph, gust factor 6 mph.",
    );
  });

  it("gives each launch its own limits and handles missing directions", () => {
    const line = prompt.split("\n").find((l) => l.startsWith("- Meadow:"));
    expect(line).toContain("Works best anywhere in the OK range");
    expect(line).toContain("OK none");
    expect(line).toContain("Wind limits 8–20 mph, gust factor 5 mph");
  });

  it("asks for current forecasts and the briefing items", () => {
    for (const phrase of [
      "not climatology",
      "say so instead of guessing",
      "gusts",
      "lapse rate",
      "cloud base",
      "overdevelopment",
      "thunderstorm",
      "fronts",
      "troughs",
      "storm systems",
      "outflow",
      "best time window",
      "go or no-go",
      "site's local time",
    ]) {
      expect(prompt).toContain(phrase);
    }
  });

  it("includes the notes lines when present and leaves them out when absent", () => {
    expect(prompt).toContain("Site notes: Park at the lower lot.");
    expect(prompt).toContain("Soaring: Ridge works in west wind.");
    expect(prompt).toContain("XC: Fly north along the range.");
    const bare = briefingPrompt(testSite(), "2026-11-16");
    for (const label of ["Site notes:", "Soaring:", "XC:"]) expect(bare).not.toContain(label);
  });

  it("carries nothing of the app's verdict", () => {
    expect(prompt).not.toContain("P9");
  });
});

describe("briefingLinks", () => {
  const tricky = "a & b # c ? d\nline two 270°";
  const links = briefingLinks(tricky);

  it("points at each service's prefill URL", () => {
    expect(links.claude.startsWith("https://claude.ai/new?q=")).toBe(true);
    expect(links.chatgpt.startsWith("https://chatgpt.com/?q=")).toBe(true);
  });

  it("encodes the prompt so it decodes back whole", () => {
    for (const url of [links.claude, links.chatgpt]) {
      const query = url.slice(url.indexOf("?q=") + 3);
      expect(query).not.toMatch(/[&#? \n]/);
      expect(decodeURIComponent(query)).toBe(tricky);
    }
  });
});

describe("showsBriefing", () => {
  it("shows for an open flying site on a day that isn't over", () => {
    expect(showsBriefing(testSite(), false)).toBe(true);
  });
  it("hides for kiting parks, closed sites and a finished day", () => {
    expect(showsBriefing(testSite({ kind: "kiting" }), false)).toBe(false);
    expect(showsBriefing(testSite({ status: { state: "closed", reason: "x" } }), false)).toBe(false);
    expect(showsBriefing(testSite(), true)).toBe(false);
  });
});

describe("copyPrompt", () => {
  it("fails without a clipboard", async () => {
    expect(await copyPrompt(undefined, "hi")).toBe("failed");
  });
  it("fails when writeText throws or rejects", async () => {
    const throws = {
      writeText: (): Promise<void> => {
        throw new Error("denied");
      },
    };
    const rejects = { writeText: () => Promise.reject(new Error("denied")) };
    expect(await copyPrompt(throws, "hi")).toBe("failed");
    expect(await copyPrompt(rejects, "hi")).toBe("failed");
  });
  it("copies the text it was given", async () => {
    let written: string | undefined;
    const ok = {
      writeText: (t: string) => {
        written = t;
        return Promise.resolve();
      },
    };
    expect(await copyPrompt(ok, "hello")).toBe("copied");
    expect(written).toBe("hello");
  });
});
