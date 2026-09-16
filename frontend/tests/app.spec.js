import { test, expect } from '@playwright/test'
import path from 'node:path'

test('upload, loading, answer, sources, replacement, and errors', async ({ page }) => {
  let uploadCount = 0
  await page.route('**/upload', async (route) => {
    uploadCount += 1
    await route.fulfill({ json: { filename: `document-${uploadCount}.pdf`, chunks_stored: 4 } })
  })
  await page.route('**/ask', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ question: 'Which database?' })
    await route.fulfill({ json: {
      answer: 'PostgreSQL.',
      sources: [{ filename: 'document-1.pdf', page: 2, text: 'The database is PostgreSQL.' }],
    } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Ask question' }).click()
  await expect(page.getByRole('alert')).toHaveText('Enter a question about your document.')
  const input = page.getByLabel('Upload PDF')
  await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') })
  await expect(page.getByRole('alert')).toHaveText('Please choose a PDF file.')
  await input.setInputFiles({ name: 'first.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test') })
  await expect(page.getByRole('status')).toContainText('document-1.pdf')
  await page.getByLabel('Your question').fill('Which database?')
  await page.getByRole('button', { name: 'Ask question' }).click()
  await expect(page.locator('.answer > p')).toHaveText('PostgreSQL.')
  await page.locator('summary').click()
  await expect(page.locator('.excerpt')).toHaveText('The database is PostgreSQL.')
  await expect(page.locator('.page')).toHaveText('Page 2')
  await input.setInputFiles({ name: 'second.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test') })
  await expect(page.getByRole('status')).toContainText('document-2.pdf')
  await expect(page.locator('.answer')).toHaveCount(0)
  await expect(page.getByLabel('Your question')).toHaveValue('')
  await page.route('**/ask', (route) => route.fulfill({ status: 503, json: { detail: 'Cannot reach Ollama.' } }))
  await page.getByLabel('Your question').fill('A question')
  await page.getByRole('button', { name: 'Ask question' }).click()
  await expect(page.getByRole('alert')).toHaveText('Cannot reach Ollama.')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('buttons are disabled during indexing and generation', async ({ page }) => {
  let releaseUpload
  const uploadWait = new Promise((resolve) => { releaseUpload = resolve })
  await page.route('**/upload', async (route) => {
    await uploadWait
    await route.fulfill({ json: { filename: 'sample.pdf', chunks_stored: 4 } })
  })
  await page.goto('/')
  await page.getByLabel('Upload PDF').setInputFiles({ name: 'sample.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test') })
  await expect(page.getByText('Reading and indexing your document…')).toBeVisible()
  await expect(page.locator('button[type="submit"]')).toBeDisabled()
  await expect(page.getByLabel('Upload PDF')).toBeDisabled()
  releaseUpload()
  await expect(page.getByRole('status')).toContainText('sample.pdf')
  let releaseAnswer
  const answerWait = new Promise((resolve) => { releaseAnswer = resolve })
  await page.route('**/ask', async (route) => {
    await answerWait
    await route.fulfill({ json: { answer: "I don't know based on the document.", sources: [] } })
  })
  await page.getByLabel('Your question').fill('Missing information?')
  await page.getByRole('button', { name: 'Ask question' }).click()
  await expect(page.locator('button[type="submit"]')).toBeDisabled()
  await expect(page.getByLabel('Upload PDF')).toBeDisabled()
  releaseAnswer()
  await expect(page.locator('.answer > p')).toHaveText("I don't know based on the document.")
})

test('live PDF upload to local FastAPI and Ollama', async ({ page }) => {
  test.skip(process.env.RAG_BROWSER_LIVE !== '1', 'Set RAG_BROWSER_LIVE=1 and start FastAPI for a live test')
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByLabel('Upload PDF').setInputFiles(path.resolve('../backend/documents/Presentation - Introducing Our New Application Today.pdf'))
  await expect(page.getByRole('status')).toContainText('Ready for questions', { timeout: 60_000 })
  await page.getByLabel('Your question').fill('What database does FreelanceHub use?')
  await page.getByRole('button', { name: 'Ask question' }).click()
  await expect(page.locator('.answer > p')).toContainText(/PostgreSQL/i, { timeout: 150_000 })
  await expect(page.locator('details')).toHaveCount(4)
  await page.locator('summary').first().click()
  await expect(page.locator('.excerpt').first()).toBeVisible()
  await page.screenshot({ path: 'test-results/live-workflow.png', fullPage: true })
  expect(errors).toEqual([])
})
