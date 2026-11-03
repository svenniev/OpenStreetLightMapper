import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.component.spec.{ts,tsx}"],
    setupFiles: ["./src/testSetup.ts"],
    env: {
      VITE_MAPILLARY_CLIENT_TOKEN: "test-viewer-token",
    },
  },
});
