import { describe, expect, it } from "vitest";
import { angularDifference, arcContains, arcsContain } from "../../../src/core/sites/degreeArc";

describe("degreeArc", () => {
  it("nonWrappingArc", () => {
    const arc = { from: 250, to: 325 };
    expect(arcContains(arc, 270)).toBe(true);
    expect(arcContains(arc, 200)).toBe(false);
    expect(arcContains(arc, 340)).toBe(false);
  });

  it("wrappingArc", () => {
    const arc = { from: 330, to: 30 };
    expect(arcContains(arc, 350)).toBe(true);
    expect(arcContains(arc, 0)).toBe(true);
    expect(arcContains(arc, 15)).toBe(true);
    expect(arcContains(arc, 90)).toBe(false);
    expect(arcContains(arc, 300)).toBe(false);
  });

  it("edgesAreInclusive", () => {
    const arc = { from: 45, to: 135 };
    expect(arcContains(arc, 45)).toBe(true);
    expect(arcContains(arc, 135)).toBe(true);
    expect(arcContains(arc, 44.9)).toBe(false);
    expect(arcContains(arc, 135.1)).toBe(false);
    const wrap = { from: 330, to: 30 };
    expect(arcContains(wrap, 330)).toBe(true);
    expect(arcContains(wrap, 30)).toBe(true);
  });

  it("threeSixtyEqualsZero", () => {
    expect(arcContains({ from: 330, to: 30 }, 360)).toBe(true);
    expect(arcContains({ from: 0, to: 45 }, 360)).toBe(true);
    expect(arcContains({ from: 315, to: 360 }, 0)).toBe(true);
  });

  it("negativeAndLargeInputsNormalize", () => {
    const arc = { from: 330, to: 30 };
    expect(arcContains(arc, -20)).toBe(true);
    expect(arcContains(arc, -90)).toBe(false);
    expect(arcContains(arc, 725)).toBe(true);
  });

  it("collectionContains", () => {
    const arcs = [
      { from: 10, to: 20 },
      { from: 200, to: 210 },
    ];
    expect(arcsContain(arcs, 205)).toBe(true);
    expect(arcsContain(arcs, 100)).toBe(false);
    expect(arcsContain([], 0)).toBe(false);
  });

  it("angularDifferenceIsShortestDistance", () => {
    expect(angularDifference(350, 10)).toBe(20);
    expect(angularDifference(10, 350)).toBe(20);
    expect(angularDifference(0, 180)).toBe(180);
    expect(angularDifference(90, 90)).toBe(0);
    expect(angularDifference(-10, 370)).toBe(20);
  });
});
