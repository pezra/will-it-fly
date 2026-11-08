import { describe, expect, it } from "vitest";
import { compass, definedMax, mph } from "../../src/core/units";

describe("compass", () => {
  it("names the 16 points", () => {
    expect(compass(0)).toBe("N");
    expect(compass(90)).toBe("E");
    expect(compass(225)).toBe("SW");
    expect(compass(292.5)).toBe("WNW");
  });
  it("wraps and rounds at the boundaries", () => {
    expect(compass(360)).toBe("N");
    expect(compass(-10)).toBe("N");
    expect(compass(349)).toBe("N");
    expect(compass(348)).toBe("NNW");
    expect(compass(11.2)).toBe("N");
    expect(compass(11.3)).toBe("NNE");
  });
});

describe("mph", () => {
  it("rounds to whole mph", () => {
    expect(mph(12.4)).toBe("12 mph");
    expect(mph(12.5)).toBe("13 mph");
  });
});

describe("definedMax", () => {
  it("is the largest defined value, or undefined when none is", () => {
    expect(definedMax(1, undefined, 3)).toBe(3);
    expect(definedMax(-2, undefined)).toBe(-2);
    expect(definedMax(undefined, undefined)).toBeUndefined();
    expect(definedMax()).toBeUndefined();
  });
});
