import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import preact from "@preact/preset-vite";

/** Every file under `dir`, as paths relative to `root` with forward slashes. */
function listFiles(root: string, dir: string = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? listFiles(root, path)
      : [relative(root, path).split(sep).join("/")];
  });
}

/**
 * After the build, fills `dist/sw.js` (copied from `public/sw.js`, the template) with a build id
 * and the list of files to precache: the shell, the manifest, the icons and every hashed asset.
 */
function serviceWorkerManifest(): Plugin {
  let outDir = "dist";
  return {
    name: "sw-precache-manifest",
    apply: "build",
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    closeBundle() {
      const files = listFiles(outDir).filter((f) => f !== "sw.js" && !f.endsWith(".map"));
      const precache = ["./", ...files.map((f) => f)];
      const buildId = Date.now().toString(36);
      const swPath = join(outDir, "sw.js");
      const template = readFileSync(swPath, "utf8");
      const buildIdPattern = /const BUILD_ID = .*;/;
      const precachePattern = /const PRECACHE = .*;/;
      if (!buildIdPattern.test(template)) throw new Error("sw.js template: BUILD_ID placeholder not found");
      if (!precachePattern.test(template)) throw new Error("sw.js template: PRECACHE placeholder not found");
      const filled = template
        .replace(buildIdPattern, `const BUILD_ID = ${JSON.stringify(buildId)};`)
        .replace(precachePattern, `const PRECACHE = ${JSON.stringify(precache)};`);
      writeFileSync(swPath, filled);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [preact(), serviceWorkerManifest()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
