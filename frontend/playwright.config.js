import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'msedge',
    headless: true,
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === '1',
    env: { VITE_API_URL: process.env.VITE_API_URL || 'http://127.0.0.1:8000' },
  },
})
