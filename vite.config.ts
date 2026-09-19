import { defineConfig } from "vite";

/**
 * 三個 entry：入口、投影幕、手機端。
 *
 * base 由 CI 帶進來（GitHub Pages 會掛在 /<repo>/ 底下），
 * 本機開發時是 "/"。
 */
export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  build: {
    target: "es2020",
    rollupOptions: {
      input: {
        index: "index.html",
        stage: "stage.html",
        play: "play.html",
      },
    },
  },
});
