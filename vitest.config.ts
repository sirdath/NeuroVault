import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // The repo runs TWO test harnesses, split by extension:
    //   *.test.tsx -> vitest (components, stores) — this config
    //   *.test.ts  -> standalone tsx scripts under src/lib, run by
    //                 scripts/run-lib-tests.mjs
    // A vitest test saved as .test.ts is collected by NEITHER and silently
    // never runs. run-lib-tests.mjs fails the gate if it finds one, but the
    // simplest way to stay out of that trap: writing vitest? use .tsx.
    include: ["src/**/*.test.tsx"],
    clearMocks: true,
    restoreMocks: true,
    css: false,
  },
});
