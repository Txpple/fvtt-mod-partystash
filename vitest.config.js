import { defineConfig } from "vitest/config";

// UNIT TIER ONLY: everything here runs offline, with no Foundry, in milliseconds. The live tier is
// tools/*.mjs, driven through the sibling MCP repo's headless browser against a real world; it
// mutates a world and is not part of `npm test`.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.js"]
  }
});
