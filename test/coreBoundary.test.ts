import { describe, expect, it } from "vitest";

const files = import.meta.glob("/src/core/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FORBIDDEN_IMPORT = /(?:from\s+|import\s*\(?\s*|import\s+)["'](?:preact(?:\/[^"']*)?|[^"']*\/ui\/[^"']*)["']/;

describe("core boundary", () => {
  it("scans the core files", () => {
    expect(Object.keys(files)).toContain("/src/core/time.ts");
  });

  it("flags imports of preact and ui (the pattern is not vacuous)", () => {
    expect(FORBIDDEN_IMPORT.test('import { h } from "preact";')).toBe(true);
    expect(FORBIDDEN_IMPORT.test('import { useState } from "preact/hooks";')).toBe(true);
    expect(FORBIDDEN_IMPORT.test('import { x } from "../ui/x";')).toBe(true);
    expect(FORBIDDEN_IMPORT.test('import("../ui/x")')).toBe(true);
    expect(FORBIDDEN_IMPORT.test('import { a } from "./time";')).toBe(false);
  });

  it("src/core imports nothing from preact or src/ui", () => {
    for (const [path, text] of Object.entries(files)) {
      expect(FORBIDDEN_IMPORT.test(text), path).toBe(false);
    }
  });
});
