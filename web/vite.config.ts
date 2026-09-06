import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  build: {
    // The Rust binary serves this directory when it exists, so a build produces
    // a single deployable artifact.
    outDir: "../server/static",
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
});
