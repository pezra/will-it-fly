import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  base: "./",
  plugins: [preact()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
