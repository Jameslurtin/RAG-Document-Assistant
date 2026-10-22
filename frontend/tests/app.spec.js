import { test, expect } from '@playwright/test'
import path from 'node:path'

function expectApiRequest(route, pathname, method = 'GET') {
  const url = new URL(route.request().url())
  const apiUrl = new URL(process.env.VITE_API_URL || 'http://127.0.0.1:8001')
  expect(url.origin).toBe(apiUrl.origin)
  expect(url.pathname).toBe(pathname)
  expect(route.request().method()).toBe(method)
}

async function mockHealthyBackend(page) {
  await page.route('**/health', (route) => {
    expectApiRequest(route, '/health')
    return route.fulfill({ json: { status: 'ok' } })
  })
}

test('backend status reflects only a successful health check', async ({ page }) => {
  let releaseHealth
  const healthWait = new Promise((resolve) => { releaseHealth = resolve })
  await page.route('**/health', async (route) => {
    expectApiRequest(route, '/health')
    await healthWait
    await route.fulfill({ json: { status: 'ok' } })
  })
  await page.route('**/documents', (route) => route.fulfill({ json: { documents: [] } }))
  await page.goto('/')
  await expect(page.getByText('Checking backend…')).toBeVisible()
  await expect(page.getByText('Backend connected')).toHaveCount(0)
  releaseHealth()
  await expect(page.getByText('Backend connected')).toBeVisible()

  await page.route('**/health', (route) => route.fulfill({ status: 503, json: { status: 'ok' } }))
  await page.reload()
  await expect(page.getByText('Backend unavailable')).toBeVisible()
  await expect(page.getByText('Backend connected')).toHaveCount(0)
})

test('upload, loading, answer, sources, replacement, and errors', async ({ page }) => {
  let uploadCount = 0
  let documents = []
  await mockHealthyBackend(page)
  const documentIds = [
    '11111111111141118111111111111111',
    '22222222222242228222222222222222',
  ]
  await page.route('**/documents', (route) => route.fulfill({ json: { documents } }))
  await page.route('**/upload', async (route) => {
    expectApiRequest(route, '/upload', 'POST')
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
    expectApiRequest(route, '/ask', 'POST')
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
  await page.setViewportSize({ width: 320, height: 740 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('buttons are disabled during indexing and generation', async ({ page }) => {
  let releaseUpload
  const uploadWait = new Promise((resolve) => { releaseUpload = resolve })
  let documents = []
  await mockHealthyBackend(page)
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

test('chat feed scrolls to long answers', async ({ page }) => {
  await mockHealthyBackend(page)
  await page.route('**/documents', (route) => route.fulfill({ json: { documents: [] } }))
  await page.route('**/ask', (route) => route.fulfill({ json: {
    answer: Array.from({ length: 50 }, (_, index) => `Evidence-backed answer line ${index + 1}.`).join('\n'),
    session_id: route.request().postDataJSON().session_id,
    sources: [],
  } }))
  await page.setViewportSize({ width: 390, height: 620 })
  await page.goto('/')
  await page.getByLabel('Your question').fill('Summarize the report.')
  await page.getByRole('button', { name: 'Ask question' }).click()
  await expect(page.locator('.chat-exchange')).toHaveCount(1)
  await expect.poll(() => page.locator('.chat-feed').evaluate(
    (feed) => feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 2,
  )).toBe(true)
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

test('agent comparison shows evidence and documents can be deleted', async ({ page }) => {
  let documents = [
    {
      document_id: '44444444444444448444444444444444',
      filename: 'guide.pdf',
      page_count: 3,
      chunk_count: 5,
    },
    {
      document_id: '88888888888848888888888888888888',
      filename: 'reference.pdf',
      page_count: 2,
      chunk_count: 3,
    },
  ]
  await mockHealthyBackend(page)
  await page.route('**/documents', (route) => route.fulfill({ json: { documents } }))
  await page.route('**/documents/*', async (route) => {
    const deletedId = new URL(route.request().url()).pathname.split('/').pop()
    expect(deletedId).toBe(documents[0].document_id)
    expectApiRequest(route, `/documents/${deletedId}`, 'DELETE')
    documents = documents.filter((document) => document.document_id !== deletedId)
    await route.fulfill({ json: { message: 'Document deleted successfully.' } })
  })
  await page.route('**/agent/ask', async (route) => {
    expectApiRequest(route, '/agent/ask', 'POST')
    const request = route.request().postDataJSON()
    expect(request.document_ids).toEqual(documents.map((document) => document.document_id))
    await route.fulfill({ json: {
      answer: 'The documents describe SQLite and PostgreSQL [guide.pdf, p. 1] [reference.pdf, p. 2].',
      session_id: request.session_id,
      sources: [
        { document_id: documents[0].document_id, filename: 'guide.pdf', page: 1, text: 'SQLite is used.' },
        { document_id: documents[1].document_id, filename: 'reference.pdf', page: 2, text: 'PostgreSQL is used.' },
      ],
      agent: {
        iterations: 2,
        tools: [{ tool: 'compare_documents', summary: 'Retrieved evidence from 2 documents.', duration_ms: 4 }],
      },
    } })
  })
  await page.goto('/')
  await expect(page.getByRole('status')).toContainText('guide.pdf')
  await page.getByLabel('Answer mode').selectOption('agent')
  await page.getByLabel('Your question').fill('Compare these documents.')
  await page.getByRole('button', { name: 'Ask question' }).click()
  await expect(page.locator('.answer > p')).toHaveText('The documents describe SQLite and PostgreSQL [guide.pdf, p. 1] [reference.pdf, p. 2].')
  await expect(page.getByText('Agent activity · 2 steps')).toBeVisible()
  await expect(page.locator('.agent-details')).toContainText('compare documents')
  await expect(page.locator('.source-card')).toHaveCount(2)
  await expect(page.locator('.source-card summary').nth(1)).toContainText('reference.pdf')
  await page.getByRole('button', { name: 'Delete guide.pdf' }).click()
  await expect(page.getByRole('status')).toContainText('reference.pdf')
})

test('refreshing after deletion preserves an explicitly empty selection', async ({ page }) => {
  let documents = [
    { document_id: '66666666666646668666666666666666', filename: 'first.pdf', page_count: 1, chunk_count: 1 },
    { document_id: '77777777777747778777777777777777', filename: 'second.pdf', page_count: 1, chunk_count: 1 },
  ]
  await mockHealthyBackend(page)
  await page.route('**/documents', (route) => route.fulfill({ json: { documents } }))
  await page.route('**/documents/*', async (route) => {
    documents = documents.filter((document) => document.document_id !== '66666666666646668666666666666666')
    await route.fulfill({ json: { message: 'Document deleted successfully.' } })
  })
  await page.goto('/')
  const selection = page.locator('.document-name input')
  await expect(selection).toHaveCount(2)
  await expect(selection.nth(0)).toBeChecked()
  await selection.nth(0).uncheck()
  await selection.nth(1).uncheck()
  await page.getByRole('button', { name: 'Delete first.pdf' }).click()
  await expect(selection).toHaveCount(1)
  await expect(selection.first()).not.toBeChecked()
  await expect(page.getByText('0 selected for retrieval')).toBeVisible()
})

test('navigation targets real panels and document list avoids unsupported metadata', async ({ page }) => {
  await mockHealthyBackend(page)
  await page.route('**/documents', (route) => route.fulfill({ json: { documents: [{
    document_id: '55555555555545558555555555555555',
    filename: 'reference.pdf',
    page_count: 4,
    chunk_count: 7,
    indexed_at: '2026-10-20T10:00:00+00:00',
  }] } }))
  await page.goto('/')

  await expect(page.getByRole('link', { name: 'Documents 1' })).toHaveAttribute('href', '#documents-panel')
  await page.getByRole('link', { name: 'AI Assistant' }).click()
  await expect(page).toHaveURL(/#assistant-panel$/)
  await expect(page.getByText('Backend connected')).toBeVisible()
  await expect(page.getByText('reference.pdf')).toBeVisible()
  await expect(page.getByText('4 pages · 7 chunks')).toBeVisible()
  await expect(page.locator('.file-status')).toHaveText(/Indexed/)
  await expect(page.getByText('Size', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Team' })).toHaveCount(0)
})
