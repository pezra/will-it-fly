// Config for `vite preview` in the error-reporting E2E run: serves the build with relative asset
// paths, and lets the page be opened as http://app.test:4173 (Chrome maps that name to localhost).
export default {
  base: "./",
  preview: { allowedHosts: ["app.test"] },
};
