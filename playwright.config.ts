import { defineConfig } from '@playwright/test';

/** Port of the preview server used by the smoke test. */
const PREVIEW_PORT = 4174;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PREVIEW_PORT}`,
    browserName: 'chromium',
    viewport: { width: 960, height: 540 },
    launchOptions: {
      // WebGPU on the SwiftShader software adapter: runs on machines without a GPU (CI).
      args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
    },
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${PREVIEW_PORT} --strictPort`,
    url: `http://localhost:${PREVIEW_PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
