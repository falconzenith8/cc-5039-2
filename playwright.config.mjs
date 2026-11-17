import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
    launchOptions: {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [
          '/tmp/chromium-libs/root/usr/lib/aarch64-linux-gnu',
          '/tmp/chromium-libs/root/lib/aarch64-linux-gnu',
          process.env.LD_LIBRARY_PATH,
        ].filter(Boolean).join(':'),
      },
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--allow-file-access-from-files',
        '--enable-blink-features=MediaSource',
      ],
    },
  },
  webServer: {
    command: 'node server.mjs',
    url: 'http://localhost:8080/api/health',
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
