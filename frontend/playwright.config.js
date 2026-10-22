import { defineConfig } from '@playwright/test'

const port = process.env.PLAYWRIGHT_PORT || '5173'
const frontendUrl = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  workers: 1,
  use: {
    baseURL: frontendUrl,
    channel: 'msedge',
    headless: true,
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: frontendUrl,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === '1',
    env: { VITE_API_URL: process.env.VITE_API_URL || 'http://127.0.0.1:8001' },
  },
})
