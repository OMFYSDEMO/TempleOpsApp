import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [preact()],
  build: { outDir: path.resolve(__dirname, "dist"), emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
