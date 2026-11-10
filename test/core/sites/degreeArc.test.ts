import { describe, expect, it } from "vitest";
import {
  angularDifference,
  arcContains,
  arcsContain,
  degreesOutsideArcs,
} from "../../../src/core/sites/degreeArc";

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

  it("degreesOutsideArcsIsZeroInside", () => {
    expect(degreesOutsideArcs([{ from: 250, to: 325 }], 270)).toBe(0);
    expect(degreesOutsideArcs([{ from: 250, to: 325 }], 250)).toBe(0);
    expect(degreesOutsideArcs([{ from: 250, to: 325 }], 325)).toBe(0);
  });

  it("degreesOutsideArcsMeasuresToNearestEdge", () => {
    const arc = { from: 250, to: 325 };
    expect(degreesOutsideArcs([arc], 249)).toBe(1);
    expect(degreesOutsideArcs([arc], 326)).toBe(1);
    expect(degreesOutsideArcs([arc], 200)).toBe(50);
  });

  it("degreesOutsideArcsWrappingArc", () => {
    const arc = { from: 337.5, to: 135 };
    expect(degreesOutsideArcs([arc], 136)).toBe(1);
    expect(degreesOutsideArcs([arc], 300)).toBe(37.5);
  });

  it("degreesOutsideArcsTakesNearestArc", () => {
    const arcs = [
      { from: 225, to: 315 },
      { from: 0, to: 45 },
    ];
    expect(degreesOutsideArcs(arcs, 330)).toBe(15);
    expect(degreesOutsideArcs(arcs, 170)).toBe(55);
  });

  it("degreesOutsideArcsFullCircleIsZero", () => {
    expect(degreesOutsideArcs([{ from: 0, to: 360 }], 123)).toBe(0);
  });

  it("degreesOutsideArcsZeroWidthArc", () => {
    const arc = { from: 270, to: 270 };
    expect(degreesOutsideArcs([arc], 270)).toBe(0);
    expect(degreesOutsideArcs([arc], 280)).toBe(10);
  });

  it("degreesOutsideArcsEmptyIsInfinity", () => {
    expect(degreesOutsideArcs([], 90)).toBe(Infinity);
  });
});
