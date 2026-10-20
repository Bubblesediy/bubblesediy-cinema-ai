import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Isolated per-test-file storage; migrations are applied in test setup.
          d1Databases: ["DB"],
          r2Buckets: ["ASSETS"],
          bindings: {
            JWT_SECRET: "test-secret-padding-to-32-bytes-minimum-ok",
            APP_NAME: "BubblesEdiy Cinema AI (test)",
            ALLOWED_ORIGIN: "http://localhost:3000",
            COMFYUI_URL: "",
            OLLAMA_URL: "",
            SCREENPLAY_MODEL: "",
            ACCESS_TOKEN_EXPIRE_MINUTES: "10080",
            MAX_UPLOAD_BYTES: "8388608",
          },
        },
      },
    },
  },
});
