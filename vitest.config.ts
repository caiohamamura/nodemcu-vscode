import { defineConfig } from "vitest/config";
import * as path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // Redirect the bare "vscode" specifier to our minimal runtime mock so
      // unit tests that import vscode-dependent modules (e.g. liveEditFs) work
      // without launching a real Extension Development Host.
      vscode: path.resolve(__dirname, "tests/__mocks__/vscode.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    sequence: {
      hooks: "list",
      concurrent: false,
    },
    pool: "forks",
    maxWorkers: 1,
  },
});
