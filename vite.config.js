import { defineConfig } from "vite";

export default defineConfig({
  base: "./", // relative paths: works on Vercel and inside any sub-path
  // mupdf ships its own WASM loader with top-level await: keep it out of pre-bundling and target modern browsers
  optimizeDeps: { exclude: ["mupdf"] },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
});
