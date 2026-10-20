import { test, expect } from '@playwright/test'
import path from 'node:path'

test('upload, loading, answer, sources, replacement, and errors', async ({ page }) => {
  let uploadCount = 0
  let documents = []
  const documentIds = [
    '11111111111141118111111111111111',
    '22222222222242228222222222222222',
  ]
  await page.route('**/documents', (route) => route.fulfill({ json: { documents } }))
  await page.route('**/upload', async (route) => {
    uploadCount += 1
    const uploaded = {
      document_id: documentIds[uploadCount - 1],
      filename: `document-${uploadCount}.pdf`,
      page_count: 2,
      chunks_stored: 4,
      chunk_count: 4,
    }
    documents = [...documents, uploaded]
    await route.fulfill({ json: { ...uploaded, documents: [uploaded] } })
  })
  await page.route('**/ask', async (route) => {
    const request = route.request().postDataJSON()
    expect(request.question).toBe('Which database?')
    expect(request.document_ids).toEqual([documentIds[0]])
    expect(request.session_id).toMatch(/[0-9a-f-]{36}/i)
    await route.fulfill({ json: {
      answer: 'PostgreSQL.',
      session_id: request.session_id,
      sources: [{ filename: 'document-1.pdf', page: 2, text: 'The database is PostgreSQL.' }],
    } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Ask question' }).click()
  await expect(page.getByRole('alert')).toHaveText('Enter a question about your documents.')
  const input = page.getByLabel('Upload PDF files')
  await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') })
  await expect(page.getByRole('alert')).toHaveText('Please choose PDF files only.')
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
  await expect(page.locator('.answer')).toHaveCount(1)
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
  let documents = []
  await page.route('**/documents', (route) => route.fulfill({ json: { documents } }))
  await page.route('**/upload', async (route) => {
    await uploadWait
    const document = {
      document_id: '33333333333343338333333333333333',
      filename: 'sample.pdf',
      page_count: 1,
      chunk_count: 4,
    }
    documents = [document]
    await route.fulfill({ json: { ...document, documents: [document] } })
  })
  await page.goto('/')
  await page.getByLabel('Upload PDF files').setInputFiles({ name: 'sample.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test') })
  await expect(page.getByText('Indexing your PDFs…')).toBeVisible()
  await expect(page.locator('button[type="submit"]')).toBeDisabled()
  await expect(page.getByLabel('Upload PDF files')).toBeDisabled()
  releaseUpload()
  await expect(page.getByRole('status')).toContainText('sample.pdf')
  let releaseAnswer
  const answerWait = new Promise((resolve) => { releaseAnswer = resolve })
  await page.route('**/ask', async (route) => {
    await answerWait
    await route.fulfill({ json: {
      answer: "I don't know based on the document.",
      session_id: route.request().postDataJSON().session_id,
      sources: [],
    } })
  })
  await page.getByLabel('Your question').fill('Missing information?')
  await page.getByRole('button', { name: 'Ask question' }).click()
  await expect(page.locator('button[type="submit"]')).toBeDisabled()
  await expect(page.getByLabel('Upload PDF files')).toBeDisabled()
  releaseAnswer()
  await expect(page.locator('.answer > p')).toHaveText("I don't know based on the document.")
})

test('live PDF upload to local FastAPI and Ollama', async ({ page }) => {
  test.skip(process.env.RAG_BROWSER_LIVE !== '1', 'Set RAG_BROWSER_LIVE=1 and start FastAPI for a live test')
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByLabel('Upload PDF files').setInputFiles(path.resolve('../backend/documents/Presentation - Introducing Our New Application Today.pdf'))
  await expect(page.getByRole('status')).toContainText('Introducing Our New Application Today', { timeout: 60_000 })
  await page.getByLabel('Your question').fill('What database does FreelanceHub use?')
  await page.getByRole('button', { name: 'Ask question' }).click()
  await expect(page.locator('.answer > p')).toContainText(/PostgreSQL/i, { timeout: 150_000 })
  await expect(page.locator('details')).toHaveCount(4)
  await page.locator('summary').first().click()
  await expect(page.locator('.excerpt').first()).toBeVisible()
  await page.screenshot({ path: 'test-results/live-workflow.png', fullPage: true })
  expect(errors).toEqual([])
})

test('agent mode shows tool activity and documents can be deleted', async ({ page }) => {
  let documents = [{
    document_id: '44444444444444448444444444444444',
    filename: 'guide.pdf',
    page_count: 3,
    chunk_count: 5,
  }]
  await page.route('**/documents', (route) => route.fulfill({ json: { documents } }))
  await page.route('**/documents/*', async (route) => {
    documents = []
    await route.fulfill({ json: { message: 'Document deleted successfully.' } })
  })
  await page.route('**/agent/ask', async (route) => {
    const request = route.request().postDataJSON()
    expect(request.document_ids).toEqual([documents[0].document_id])
    await route.fulfill({ json: {
      answer: 'The guide describes SQLite [guide.pdf, p. 1].',
      session_id: request.session_id,
      sources: [{ document_id: documents[0].document_id, filename: 'guide.pdf', page: 1, text: 'SQLite is used.' }],
      agent: {
        iterations: 2,
        tools: [{ tool: 'search_documents', summary: 'Retrieved 1 relevant passage.', duration_ms: 4 }],
      },
    } })
  })
  await page.goto('/')
  await expect(page.getByRole('status')).toContainText('guide.pdf')
  await page.getByLabel('Answer mode').selectOption('agent')
  await page.getByLabel('Your question').fill('What database is used?')
  await page.getByRole('button', { name: 'Ask question' }).click()
  await expect(page.locator('.answer > p')).toHaveText('The guide describes SQLite [guide.pdf, p. 1].')
  await expect(page.getByText('Agent activity · 2 steps')).toBeVisible()
  await page.getByRole('button', { name: 'Delete guide.pdf' }).click()
  await expect(page.getByRole('status')).toContainText('No PDFs uploaded')
})
