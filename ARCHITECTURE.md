# Architecture

## Traditional RAG and Agentic RAG

Traditional retrieval-augmented generation follows one predictable path:

1. Turn the user's question into an embedding.
2. Find nearby document chunks in Chroma.
3. Pass the chunks and question to the language model.
4. Return the answer and the chunks as sources.

Agentic RAG adds a planning step. The configured language model chooses one
allowlisted action at a time: search, inspect document metadata, compare
documents, rewrite a query, or finish. The backend executes the selected tool
and gives the planner a short execution summary before the next step. It never
lets the model execute arbitrary code or construct arbitrary database queries.
An iteration limit and a one-rewrite limit bound cost and prevent loops.
Document inventory questions are recognized before planning and sent directly
to `get_document_info`, so counts and filenames come from index metadata
instead of semantic chunk retrieval.

The current implementation uses JSON text planning, not native function calling
or LangGraph. That keeps Ollama, Gemini, and OpenAI behind the same small
provider interface. The planner sees document names and tool summaries, but not
full retrieved passage text; only the final answer step receives excerpts.

## PDF ingestion

`POST /upload` accepts one `file` field or multiple `files` fields. The API:

1. Sanitizes the displayed filename, checks the extension and PDF signature,
   and enforces the configured maximum size while streaming the file to disk.
2. Assigns each upload a UUID and stores the PDF under `DATA_DIR/documents/`.
3. Extracts text page by page with PyPDF. Encrypted, damaged, empty, or
   textless files are rejected rather than indexed as successful uploads.
4. Splits each page into 500-character chunks with 100-character overlap. Each
   chunk retains its document UUID, display name, page number, total page count,
   upload time, and content hash.
5. Generates embeddings and adds chunks to the persistent Chroma collection.

Each document gets unique chunk IDs (`document UUID:chunk index`), and the
SHA-256 digest avoids indexing the same exact PDF contents twice. A failed
embedding or vector insert does not report an indexed document. Deleting a
document removes all vectors with its UUID and removes its stored PDF.

## Embeddings and vector search

The backend uses one embedding model for both document and query vectors:

- `EMBEDDING_PROVIDER=local`: SentenceTransformer `all-MiniLM-L6-v2`.
- `EMBEDDING_PROVIDER=gemini`: Gemini `gemini-embedding-001`, using
  `RETRIEVAL_DOCUMENT` and `RETRIEVAL_QUERY` task types.

Chroma stores the vectors and scalar metadata in a persistent collection using
cosine distance. Search can filter by a selected set of document UUIDs. The
default retrieval limit is four passages; comparison retrieves up to eight.
The selected provider and model are read at process start; do not mix vector
spaces in one collection. If the embedding model changes, clear/rebuild the
index and re-upload the documents.

## Agent orchestration

`backend/agent.py` owns the bounded loop. For each request it supplies the
planner with the current question, bounded conversation history, selected
document metadata, and compact summaries of prior tools. It validates the
model's JSON action against a fixed allowlist before execution. Invalid planner
JSON falls back to a standard retrieval action and is logged.

The maximum is five loop iterations. `rewrite_search_query` is only executed
once per request. Tool activity includes the action, a human-readable summary,
and elapsed time; these are returned to the UI without returning hidden
provider details. Provider errors remain visible through HTTP error responses.
If there is no evidence, the assistant returns the explicit "I don't know"
fallback rather than asking a language model to invent an answer.

### Tool responsibilities

- **`search_documents`**: semantic retrieval, optionally filtered to selected
  document UUIDs; returns text, distance, filename, page, and document identity.
- **`get_document_info`**: returns indexed file metadata and supports empty
  libraries without calling a language model.
- **`compare_documents`**: performs cross-document retrieval. The answer path
  is allowed only when relevant chunks are present from at least two documents.
- **`rewrite_search_query`**: asks the configured provider for one concise,
  evidence-neutral search query; the orchestrator enforces the one-retry limit.

Standard RAG and the agent share extraction, embedding, retrieval, citation,
provider, and conversation-memory code to avoid behavior drift.

## Conversation memory

The frontend creates a random session UUID stored in the browser's
`sessionStorage`. It submits that ID with each question. A bounded in-memory
backend store keeps up to eight turns per session, truncates stored text, and
caps the number of sessions. A different session ID cannot access another
session's history. Prior user questions and assistant responses can help resolve
follow-up references; assistant responses are labelled unverified context and
never count as retrieved evidence.

Memory is intentionally simple: it is process-local and lost on restart. This
portfolio MVP should run one backend worker; production multi-worker deployments
would need a shared store with explicit TTL and access control.

## Citation generation and prompt-injection handling

Each source includes `document_id`, original filename, one-based page number,
and its excerpt. The final prompt supplies excerpts inside explicit untrusted
data delimiters, instructs the model to ignore instructions found in the
documents, and asks for inline `[filename, p. N]` citations. The response also
returns the source objects separately so the UI can display and expand them.

This design reduces prompt-injection risk, but a language model can still make
mistakes. The tool planner does not receive complete document excerpts, actions
are allowlisted, and generated answers without retrieved evidence are blocked.
Source excerpts remain visible for human verification.

## API and frontend

FastAPI validates question length, UUID-shaped session/document IDs, upload
types, and upload size. The `/ask` response keeps its original `answer` and
`sources` fields; it adds `session_id`. `/agent/ask` adds an `agent` object.
The UI can select Standard RAG or Agentic RAG, choose which documents to search,
view the conversation, inspect evidence, and expand the tool log.

CORS is limited to the local Vite origins plus an optional explicit
`FRONTEND_ORIGIN`. The API does not return model credentials or detailed
provider diagnostics to clients.

## Persistence and engineering trade-offs

- Chroma uses persistent storage and uploaded files share the configured
  `DATA_DIR`. Docker Compose mounts this directory as a named volume.
- Docker's backend image omits PyTorch to keep the image smaller. Compose uses
  Gemini embeddings by default; hosted embedding mode requires a key. Local
  development can install the optional SentenceTransformer dependency.
- Hosted and local language models use a common text API. Native tool calls
  were avoided because tool support and structured output vary by provider.
- One global Chroma collection with UUID metadata avoids collection proliferation
  and supports cross-document retrieval. The service has no authentication,
  tenant boundary, backup, or document-level ACL; it is a single-user portfolio
  application and must not be exposed as a multi-user service.
- Page-local chunks simplify citations and avoid merging unrelated pages, at
  the cost of splitting some concepts that cross page boundaries.
- OCR, streaming responses, persistent chat history, sentence-level citation
  verification, and provider retry policies are deferred.
