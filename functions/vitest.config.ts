import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests sequentially to avoid Firestore Emulator port conflicts
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    environment: "node",
    globals: true,
    // Exclude integration tests — they require the Firebase Emulator (run via test:integration script)
    exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
    // Activate KMSMock for all tests
    env: {
      NODE_ENV: "test",
    },
    coverage: {
      reporter: ["text", "json"],
    },
  },
});
