import { useState } from 'react'

const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'

async function request(path, options) {
  let response
  try {
    response = await fetch(`${API_URL}${path}`, options)
  } catch {
    throw new Error('Cannot reach the backend. Check that FastAPI is running on port 8000.')
  }
  const data = await response.json()
  if (!response.ok) {
    const detail = Array.isArray(data.detail)
      ? data.detail.map((item) => item.msg).join(' ')
      : data.detail
    throw new Error(detail || 'Something went wrong. Please try again.')
  }
  return data
}

function Sources({ sources }) {
  return (
    <section className="sources" aria-labelledby="sources-title">
      <h3 id="sources-title">Retrieved sources <span>{sources.length}</span></h3>
      <p className="muted">Excerpts used as context for this answer.</p>
      {sources.map((source, index) => (
        <details key={`${source.filename}-${source.page}-${index}`}>
          <summary><span>{source.filename}</span><span className="page">Page {source.page}</span></summary>
          <p className="excerpt">{source.text}</p>
        </details>
      ))}
    </section>
  )
}

export default function App() {
  const [document, setDocument] = useState(null)
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  async function upload(file) {
    if (!file) return
    setError('')
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError('Please choose a PDF file.')
      return
    }
    setBusy('upload')
    try {
      const form = new FormData()
      form.append('file', file)
      const uploaded = await request('/upload', { method: 'POST', body: form })
      setDocument(uploaded)
      setResult(null)
      setQuestion('')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  async function ask(event) {
    event.preventDefault()
    setError('')
    if (!question.trim()) {
      setError('Enter a question about your document.')
      return
    }
    setBusy('ask')
    setResult(null)
    try {
      setResult(await request('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.trim() }),
      }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="app-shell">
      <header>
        <a className="brand" href="/" aria-label="Document Assistant home"><span className="brand-icon">D</span> DOCUMENT ASSISTANT</a>
        <span className="local-badge"><i /> Runs locally</span>
      </header>
      <main>
        <div className="intro">
          <p className="eyebrow">YOUR DOCUMENTS, IN FOCUS</p>
          <h1>Less searching.<br /><em>More understanding.</em></h1>
          <p>Upload a PDF, ask a question, and explore answers grounded in your document.</p>
        </div>
        <div className="workspace">
          <aside className="panel document-panel">
            <p className="step">01 / YOUR DOCUMENT</p>
            <h2>Start with a PDF</h2>
            <label className={`upload-area ${busy ? 'disabled' : ''}`}>
              <span className="upload-icon" aria-hidden="true">↑</span>
              <strong>{busy === 'upload' ? 'Indexing your PDF…' : 'Choose a PDF'}</strong>
              <span>Click to browse your files</span>
              <input type="file" accept=".pdf,application/pdf" aria-label="Upload PDF" disabled={Boolean(busy)}
                onChange={(event) => { upload(event.target.files[0]); event.target.value = '' }} />
            </label>
            <div className="document-status" role="status">
              <span className={`status-dot ${document ? 'ready' : ''}`} />
              <div><strong>{document ? document.filename : 'No PDF uploaded in this session'}</strong>
                <p>{document ? `${document.chunks_stored} chunks indexed · Ready for questions` : 'Choose a document to get started.'}</p>
              </div>
            </div>
            <p className="helper">One active PDF at a time. Uploading a new document replaces the previous index.</p>
          </aside>
          <section className="panel question-panel" aria-labelledby="question-title">
            <p className="step">02 / ASK & EXPLORE</p>
            <h2 id="question-title">What would you like to know?</h2>
            <form onSubmit={ask}>
              <label htmlFor="question">Your question</label>
              <textarea id="question" value={question} onChange={(event) => setQuestion(event.target.value)}
                placeholder="What are the key points in this document?" rows="4" disabled={Boolean(busy)} />
              <div className="form-footer"><span>Answers use your PDF as context.</span>
                <button type="submit" disabled={Boolean(busy)}>{busy === 'ask' ? 'Finding an answer…' : 'Ask question →'}</button>
              </div>
            </form>
            {error && <div className="error" role="alert">{error}</div>}
            <div aria-live="polite" aria-busy={Boolean(busy)}>
              {busy && <p className="loading"><span className="spinner" />{busy === 'upload' ? 'Reading and indexing your document…' : 'Reading relevant passages and generating your answer…'}</p>}
              {result ? (
                <section className="answer" aria-labelledby="answer-title">
                  <h3 id="answer-title">Answer</h3><p>{result.answer}</p>
                  <Sources sources={result.sources || []} />
                </section>
              ) : !busy && <div className="empty-answer"><span aria-hidden="true">↳</span><p>A little clarity starts with a question.<br /><small>Your answer and source excerpts will appear here.</small></p></div>}
            </div>
          </section>
        </div>
      </main>
      <footer>RAG Document Assistant <span>Local documents. Local answers.</span></footer>
    </div>
  )
}
