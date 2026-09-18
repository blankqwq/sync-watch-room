import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 4173,
    strictPort: true,
    proxy: {
      "/ws": {
        target: process.env.WS_PROXY_TARGET || "ws://localhost:4174",
        ws: true,
      },
    },
  },
});
