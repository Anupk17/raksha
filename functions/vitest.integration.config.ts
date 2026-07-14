/**
 * Vitest config for integration tests that run against the Firebase Emulator Suite.
 *
 * These tests require the Emulator to be running before execution:
 *   firebase emulators:start --only firestore,storage,auth
 *
 * They are separated from unit tests because:
 *   1. They require a running Emulator process (not suitable for pure CI without Emulator setup)
 *   2. They are intentionally slower (real network I/O to Emulator)
 *   3. P18 specifically requires true concurrent Firestore transactions, which
 *      in-process mocks cannot simulate
 *
 * Environment variables set automatically by @firebase/rules-unit-testing:
 *   FIRESTORE_EMULATOR_HOST=localhost:8080
 *   FIREBASE_STORAGE_EMULATOR_HOST=localhost:9199
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    environment: "node",
    globals: true,
    include: ["src/**/*.integration.test.ts"],
    // Integration tests get a longer timeout — real Emulator I/O
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      FUNCTIONS_EMULATOR: "true",
      EVIDENCE_RETENTION_DAYS: "90",
      GCLOUD_PROJECT: "raksha-test",
    },
  },
});
