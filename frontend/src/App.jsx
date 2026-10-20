import { useEffect, useState } from 'react'

const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'

function createSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16)
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16)
  })
}

async function request(path, options) {
  let response
  try {
    response = await fetch(`${API_URL}${path}`, options)
  } catch {
    throw new Error('Cannot reach the backend. Check that FastAPI is running on port 8000.')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = Array.isArray(data.detail)
      ? data.detail.map((item) => item.msg).join(' ')
      : data.detail
    throw new Error(detail || 'Something went wrong. Please try again.')
  }
  return data
}

function Sources({ sources }) {
  if (!sources?.length) return null
  return (
    <section className="sources" aria-label="Retrieved sources">
      <h3>Retrieved sources <span>{sources.length}</span></h3>
      <p className="muted">Excerpts used as evidence for this answer.</p>
      {sources.map((source, index) => (
        <details key={`${source.document_id}-${source.page}-${index}`}>
          <summary><span>{source.filename}</span><span className="page">Page {source.page}</span></summary>
          <p className="excerpt">{source.text}</p>
        </details>
      ))}
    </section>
  )
}

function AgentDetails({ agent }) {
  if (!agent) return null
  return (
    <details className="agent-details">
      <summary>Agent activity · {agent.iterations} step{agent.iterations === 1 ? '' : 's'}</summary>
      <ol>
        {agent.tools.map((tool, index) => (
          <li key={`${tool.tool}-${index}`}>
            <strong>{tool.tool.replaceAll('_', ' ')}</strong>
            <span>{tool.summary}</span>
            {tool.duration_ms != null && <small>{tool.duration_ms} ms</small>}
          </li>
        ))}
      </ol>
    </details>
  )
}

export default function App() {
  const [documents, setDocuments] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState([])
  const [mode, setMode] = useState('standard')
  const [sessionId, setSessionId] = useState(() => {
    const existing = sessionStorage.getItem('rag-session-id')
    if (existing) return existing
    const created = createSessionId()
    sessionStorage.setItem('rag-session-id', created)
    return created
  })
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  async function refreshDocuments(selectAll = false) {
    const data = await request('/documents')
    setDocuments(data.documents || [])
    setSelectedIds((current) => {
      if (selectAll) return data.documents.map((document) => document.document_id)
      const valid = current.filter((id) => data.documents.some((document) => document.document_id === id))
      return valid.length ? valid : data.documents.map((document) => document.document_id)
    })
  }

  useEffect(() => {
    refreshDocuments().catch((err) => setError(err.message))
  }, [])

  async function upload(files) {
    if (!files?.length) return
    setError('')
    const invalid = Array.from(files).find((file) => !file.name.toLowerCase().endsWith('.pdf'))
    if (invalid) {
      setError('Please choose PDF files only.')
      return
    }
    setBusy('upload')
    try {
      const form = new FormData()
      Array.from(files).forEach((file) => form.append('files', file))
      const uploaded = await request('/upload', { method: 'POST', body: form })
      if (uploaded.errors?.length) {
        setError(uploaded.errors.map((item) => `${item.filename}: ${item.detail}`).join(' '))
      }
      await refreshDocuments(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  async function removeDocument(document) {
    setError('')
    setBusy(`delete:${document.document_id}`)
    try {
      await request(`/documents/${document.document_id}`, { method: 'DELETE' })
      await refreshDocuments()
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
      setError('Enter a question about your documents.')
      return
    }
    const submittedQuestion = question.trim()
    setBusy('ask')
    setQuestion('')
    try {
      const path = mode === 'agent' ? '/agent/ask' : '/ask'
      const result = await request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: submittedQuestion,
          session_id: sessionId,
          document_ids: selectedIds,
        }),
      })
      setMessages((current) => [...current, { question: submittedQuestion, result }])
    } catch (err) {
      setQuestion(submittedQuestion)
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  function newConversation() {
    const nextSession = createSessionId()
    sessionStorage.setItem('rag-session-id', nextSession)
    setSessionId(nextSession)
    setMessages([])
    setQuestion('')
    setError('')
  }

  function toggleDocument(documentId) {
    setSelectedIds((current) => current.includes(documentId)
      ? current.filter((id) => id !== documentId)
      : [...current, documentId])
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
          <p>Upload PDFs, ask a question, and explore answers grounded in your documents.</p>
        </div>
        <div className="workspace">
          <aside className="panel document-panel">
            <p className="step">01 / YOUR DOCUMENTS</p>
            <h2>Build your library</h2>
            <label className={`upload-area ${busy ? 'disabled' : ''}`}>
              <span className="upload-icon" aria-hidden="true">↑</span>
              <strong>{busy === 'upload' ? 'Indexing your PDFs…' : 'Choose PDF files'}</strong>
              <span>Select one or more PDFs</span>
              <input type="file" accept=".pdf,application/pdf" multiple aria-label="Upload PDF files" disabled={Boolean(busy)}
                onChange={(event) => { upload(event.target.files); event.target.value = '' }} />
            </label>
            <div className="document-list" aria-label="Uploaded documents" role="status">
              {documents.length ? documents.map((document) => (
                <div className="document-item" key={document.document_id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(document.document_id)}
                      onChange={() => toggleDocument(document.document_id)}
                      disabled={Boolean(busy)}
                    />
                    <span><strong>{document.filename}</strong>
                      <small>{document.page_count} pages · {document.chunk_count} chunks</small>
                    </span>
                  </label>
                  <button type="button" className="delete-button" aria-label={`Delete ${document.filename}`}
                    onClick={() => removeDocument(document)} disabled={Boolean(busy)}>
                    {busy === `delete:${document.document_id}` ? '…' : 'Delete'}
                  </button>
                </div>
              )) : <p className="muted">No PDFs uploaded. Add one to start asking questions.</p>}
            </div>
            <p className="helper">{selectedIds.length} of {documents.length} documents selected for retrieval.</p>
          </aside>
          <section className="panel question-panel" aria-labelledby="question-title">
            <p className="step">02 / ASK & EXPLORE</p>
            <div className="question-heading">
              <h2 id="question-title">What would you like to know?</h2>
              <button type="button" className="secondary-button" onClick={newConversation} disabled={Boolean(busy)}>New chat</button>
            </div>
            <label className="mode-picker" htmlFor="rag-mode">Answer mode
              <select id="rag-mode" value={mode} onChange={(event) => setMode(event.target.value)} disabled={Boolean(busy)}>
                <option value="standard">Standard RAG</option>
                <option value="agent">Agentic RAG</option>
              </select>
            </label>
            <form onSubmit={ask}>
              <label htmlFor="question">Your question</label>
              <textarea id="question" value={question} onChange={(event) => setQuestion(event.target.value)}
                placeholder="What are the key points in these documents?" rows="4" disabled={Boolean(busy)} />
              <div className="form-footer"><span>{mode === 'agent' ? 'The agent chooses tools and shows its work.' : 'Answers use selected PDF excerpts as evidence.'}</span>
                <button type="submit" disabled={Boolean(busy)}>{busy === 'ask' ? 'Finding an answer…' : 'Ask question →'}</button>
              </div>
            </form>
            {error && <div className="error" role="alert">{error}</div>}
            <div aria-live="polite" aria-busy={Boolean(busy)}>
              {busy === 'ask' && <p className="loading"><span className="spinner" />{mode === 'agent' ? 'Planning and checking your documents…' : 'Reading relevant passages and generating your answer…'}</p>}
              {messages.length ? messages.map((message, index) => (
                <article className="chat-message" key={`${message.result.session_id}-${index}`}>
                  <div className="user-question"><span>You</span><p>{message.question}</p></div>
                  <section className="answer">
                    <h3>Answer</h3><p>{message.result.answer}</p>
                    <Sources sources={message.result.sources || []} />
                    <AgentDetails agent={message.result.agent} />
                  </section>
                </article>
              )) : !busy && <div className="empty-answer"><span aria-hidden="true">↳</span><p>A little clarity starts with a question.<br /><small>Your answer and source excerpts will appear here.</small></p></div>}
            </div>
          </section>
        </div>
      </main>
      <footer>RAG Document Assistant <span>Local documents. Local answers.</span></footer>
    </div>
  )
}
