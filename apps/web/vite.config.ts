import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@haf/shared": path.resolve(__dirname, "../../packages/shared/src"),
      "@haf/ui": path.resolve(__dirname, "../../packages/ui/src"),
      "@haf/viewer": path.resolve(__dirname, "../../packages/viewer/src"),
      "@haf/schemas": path.resolve(__dirname, "../../packages/schemas/src"),
      "@haf/component-registry": path.resolve(__dirname, "../../packages/component-registry/src"),
      "@haf/pricing": path.resolve(__dirname, "../../packages/pricing/src"),
      "@haf/validation": path.resolve(__dirname, "../../packages/validation/src")
    }
  },
  server: {
    port: 5173
  }
});
