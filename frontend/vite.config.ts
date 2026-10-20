import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const CLOUD_RUN_AGENT_URL =
  process.env.VITE_DEPLOYED_AGENT_URL ||
  "https://evac-readiness-agent-861336771001.us-east1.run.app";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/adk-cloud-run": {
        target: CLOUD_RUN_AGENT_URL,
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/adk-cloud-run/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.removeHeader("origin");
            proxyReq.removeHeader("referer");
          });
        },
      },
    },
  },
});
