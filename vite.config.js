import { defineConfig } from "vite";

export default defineConfig({
  // mupdf ships its own WASM loader with top-level await: keep it out of pre-bundling and target modern browsers
  optimizeDeps: { exclude: ["mupdf"] },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
});
