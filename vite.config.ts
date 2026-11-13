import { defineConfig } from "vite";
import { noiseSuppressionAudioWorkletVitePlugin } from "@workadventure/noise-suppression/vite";
export default defineConfig({
  plugins: [noiseSuppressionAudioWorkletVitePlugin()],
  build: { outDir: "dist/web" },
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
});
