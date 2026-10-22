import { useEffect, useRef, useState } from 'react'

const API_URL = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:8001').replace(/\/+$/, '')

const iconPaths = {
  folder: <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></>,
  upload: <><path d="M12 16V4m0 0L8 8m4-4 4 4" /><path d="M20 16.5v2A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-2" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8m-8 4h8" /></>,
  plus: <><path d="M12 5v14m-7-7h14" /></>,
  send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
  sparkle: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-2-5.8L4 11l6-2.2z" /><path d="m19 14 1.2 2.8L23 18l-2.8 1.2L19 22l-1.2-2.8L15 18l2.8-1.2z" /></>,
  trash: <><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
}

function Icon({ name, size = 18, strokeWidth = 1.7 }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {iconPaths[name]}
    </svg>
  )
}

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
    throw new Error(`Cannot reach the backend at ${API_URL}. Check that FastAPI is running.`)
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
      <div className="source-heading">
        <span>Sources</span>
        <span className="source-count">{sources.length}</span>
      </div>
      <div className="source-list">
        {sources.map((source, index) => (
          <details className="source-card" key={`${source.document_id}-${source.page}-${index}`}>
            <summary>
              <span className="source-file-icon"><Icon name="file" size={15} /></span>
              <span className="source-title">{source.filename}<small className="page">Page {source.page}</small></span>
              <Icon name="chevron" size={15} />
            </summary>
            <p className="excerpt">{source.text}</p>
          </details>
        ))}
      </div>
    </section>
  )
}

function AgentDetails({ agent }) {
  if (!agent) return null
  return (
    <details className="agent-details">
      <summary><Icon name="sparkle" size={15} /> Agent activity · {agent.iterations} step{agent.iterations === 1 ? '' : 's'}</summary>
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

function documentInitials(filename) {
  const extension = filename.split('.').pop()?.toLowerCase()
  return extension === 'pdf' ? 'PDF' : (extension || 'DOC').slice(0, 3).toUpperCase()
}

export default function App() {
  const [documents, setDocuments] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const hasLoadedDocuments = useRef(false)
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState([])
  const [mode, setMode] = useState('standard')
  const [backendStatus, setBackendStatus] = useState('checking')
  const chatFeedRef = useRef(null)
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
    const nextDocuments = data.documents || []
    const shouldSelectAll = selectAll || !hasLoadedDocuments.current
    hasLoadedDocuments.current = true
    setDocuments(nextDocuments)
    setSelectedIds((current) => {
      if (shouldSelectAll) return nextDocuments.map((document) => document.document_id)
      return current.filter((id) => nextDocuments.some((document) => document.document_id === id))
    })
  }

  useEffect(() => {
    request('/health')
      .then((health) => {
        if (health.status !== 'ok') throw new Error('Backend health check failed.')
        setBackendStatus('connected')
      })
      .catch(() => setBackendStatus('unavailable'))

    refreshDocuments().catch((err) => {
      setError(err.message)
    })
  }, [])

  useEffect(() => {
    const feed = chatFeedRef.current
    if (feed) feed.scrollTop = feed.scrollHeight
  }, [messages, busy])

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
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Document Assistant home">
          <span className="brand-mark"><Icon name="book" size={18} /></span>
          <span>RAG Assistant</span>
        </a>

        <nav className="sidebar-nav" aria-label="Main navigation">
          <p className="nav-label">Workspace</p>
          <a className="nav-item" href="#documents-panel">
            <Icon name="folder" size={17} /> Documents <span className="nav-count">{documents.length}</span>
          </a>
          <a className="nav-item" href="#assistant-panel">
            <Icon name="sparkle" size={17} /> AI Assistant
          </a>
        </nav>

      </aside>

      <section className="library-panel" id="documents-panel" aria-labelledby="library-title">
        <header className="library-header">
          <div className="workspace-crumb"><span>Workspace</span><Icon name="chevron" size={13} /><strong>Knowledge base</strong></div>
          <div className="library-title-row">
            <div>
              <p className="eyebrow">YOUR KNOWLEDGE SPACE</p>
              <h1 id="library-title">Knowledge base</h1>
              <p className="library-subtitle">Your files, ready to think with.</p>
            </div>
          </div>
        </header>

        <div className="library-content">
          <label className={`upload-area ${busy ? 'disabled' : ''}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); upload(event.dataTransfer.files) }}>
            <span className="upload-icon"><Icon name="upload" size={21} /></span>
            <strong>{busy === 'upload' ? 'Indexing your PDFs…' : 'Upload knowledge'}</strong>
            <span>Drag files here or <b>browse</b></span>
            <small>PDF files · Max 25 MB each</small>
                <input type="file" accept=".pdf,application/pdf" multiple aria-label="Upload PDF files" disabled={Boolean(busy)}
                  onChange={(event) => { upload(event.target.files); event.target.value = '' }} />
          </label>

          <div className="documents-heading">
            <div><h2>Documents</h2><span className="document-count">{documents.length}</span></div>
            <span className="indexed-note">Synced from backend</span>
          </div>

          <div className="document-table" aria-label="Uploaded documents" role="status">
            <div className="table-head">
              <span>File name</span><span>Status</span><span>Indexed</span><span aria-hidden="true" />
            </div>
            {documents.length ? documents.map((document) => (
              <article className={`document-row ${selectedIds.includes(document.document_id) ? 'selected' : ''}`}
                key={document.document_id}>
                <label className="document-name">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(document.document_id)}
                    onChange={() => toggleDocument(document.document_id)}
                    disabled={Boolean(busy)}
                  />
                  <span className="file-badge">{documentInitials(document.filename)}</span>
                  <span className="file-description"><strong title={document.filename}>{document.filename}</strong>
                    <small>{document.page_count} pages · {document.chunk_count} chunks</small>
                  </span>
                </label>
                <span className="file-status"><i /> Indexed</span>
                <span className="file-date">{document.indexed_at ? new Date(document.indexed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Today'}</span>
                <button type="button" className="icon-button delete-button" aria-label={`Delete ${document.filename}`}
                  onClick={() => removeDocument(document)} disabled={Boolean(busy)} title="Delete document">
                  {busy === `delete:${document.document_id}`
                    ? <span className="spinner" />
                    : <Icon name="trash" size={15} />}
                </button>
              </article>
            )) : (
              <div className="empty-library">
                <span className="empty-file-icon"><Icon name="file" size={20} /></span>
                <strong>No PDFs uploaded yet</strong>
                <span>Upload a PDF to start building your knowledge base.</span>
              </div>
            )}
          </div>
          <p className="selection-note">{selectedIds.length} selected for retrieval</p>
        </div>

        {error && <div className="error library-error" role="alert">{error}</div>}
      </section>

      <section className="chat-panel" id="assistant-panel" aria-labelledby="assistant-title">
        <header className="chat-header">
          <div className="assistant-avatar"><Icon name="sparkle" size={19} /></div>
          <div className="assistant-heading">
            <h2 id="assistant-title">AI Assistant</h2>
            <span className={`backend-status ${backendStatus}`}>
              <i />{backendStatus === 'checking'
                ? 'Checking backend…'
                : backendStatus === 'connected'
                  ? 'Backend connected'
                  : 'Backend unavailable'}
            </span>
          </div>
          <button type="button" className="icon-button new-chat-button" onClick={newConversation} disabled={Boolean(busy)}
            aria-label="New chat" title="New chat"><Icon name="plus" size={18} /></button>
        </header>

        <div className="chat-controls">
          <label className="mode-picker" htmlFor="rag-mode">
            <span>Mode</span>
            <select id="rag-mode" aria-label="Answer mode" value={mode} onChange={(event) => setMode(event.target.value)} disabled={Boolean(busy)}>
              <option value="standard">Standard RAG</option>
              <option value="agent">Agentic RAG</option>
            </select>
          </label>
          <span className="selected-documents"><Icon name="file" size={14} /> {selectedIds.length} files</span>
        </div>

        <div ref={chatFeedRef} className="chat-feed" aria-live="polite" aria-busy={Boolean(busy)}>
          {!messages.length && (
            <div className="welcome-message">
              <span className="message-avatar assistant-mini"><Icon name="sparkle" size={15} /></span>
              <div>
                <div className="message-bubble assistant-bubble">
                  <p>Hello! I’m ready to answer questions about your knowledge base.</p>
                  <p>{documents.length && selectedIds.length
                    ? <>I can search across <strong>{selectedIds.length} selected document{selectedIds.length === 1 ? '' : 's'}</strong>. Ask me anything.</>
                    : documents.length
                      ? 'Select at least one file in the library before asking a question.'
                    : 'Upload a document to get started. Your answers will include source references.'}</p>
                </div>
                <span className="message-time">Just now</span>
              </div>
            </div>
          )}

          {messages.map((message, index) => (
            <article className="chat-exchange" key={`${message.result.session_id}-${index}`}>
              <div className="user-message">
                <p>{message.question}</p><span className="user-avatar">J</span>
              </div>
              <div className="assistant-message">
                <span className="message-avatar assistant-mini"><Icon name="sparkle" size={15} /></span>
                <div className="assistant-response">
                  <div className="message-bubble assistant-bubble answer">
                    <p>{message.result.answer}</p>
                    <Sources sources={message.result.sources || []} />
                    <AgentDetails agent={message.result.agent} />
                  </div>
                  <span className="message-time">Just now</span>
                </div>
              </div>
            </article>
          ))}
          {busy === 'ask' && (
            <div className="assistant-message">
              <span className="message-avatar assistant-mini"><Icon name="sparkle" size={15} /></span>
              <div className="message-bubble assistant-bubble loading-bubble">
                <span className="spinner" />{mode === 'agent' ? 'Planning and checking your documents…' : 'Searching your knowledge base…'}
              </div>
            </div>
          )}
        </div>

        <div className="composer-area">
          <form className="chat-composer" onSubmit={ask}>
            <label className="visually-hidden" htmlFor="question">Your question</label>
            <textarea id="question" value={question} onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask a question about your documents…" rows="1" disabled={Boolean(busy)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  event.currentTarget.form.requestSubmit()
                }
              }} />
            <button type="submit" disabled={Boolean(busy)} aria-label="Ask question" title="Send question">
              {busy === 'ask' ? <span className="spinner" /> : <Icon name="send" size={17} />}
            </button>
          </form>
          <div className="composer-footnote"><span>↵ to send</span><span>AI can make mistakes. Verify important information.</span><span>Shift + ↵ for a new line</span></div>
        </div>
      </section>
    </main>
  )
}
