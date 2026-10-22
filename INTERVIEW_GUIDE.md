# Interview Guide: RAG Document Assistant

This guide explains the project in simple terms and gives you a way to talk
about the decisions in an interview.

## 1. What does the application do?

It lets someone upload PDF documents and ask questions about them. The backend
searches the documents for relevant passages, gives those passages to a
language model, and returns an answer with file and page references.

There are two modes:

- **Standard RAG:** always searches for relevant passages, then asks the model to
  answer from them.
- **Agentic RAG:** usually asks a planner which safe tool should run. Questions
  asking for document counts or filenames go directly to the metadata tool.
  The planner can search, list document information, compare documents, or
  rewrite a query once before answering.

## 2. What does RAG mean?

RAG stands for **Retrieval-Augmented Generation**:

- **Retrieval** finds useful parts of the documents.
- **Augmented** means those parts are added to the model's input.
- **Generation** is the model's written answer.

The model does not need to remember the PDFs during training. The application
looks up evidence at question time and makes it available in the prompt.

## 3. How does a PDF become searchable?

1. FastAPI checks the filename, PDF signature, and maximum file size.
2. PyPDF extracts text one page at a time.
3. The backend splits each page into short overlapping chunks. Overlap helps
   preserve a sentence or idea that happens to cross a chunk boundary.
4. An embedding model turns each chunk into a list of numbers. Those numbers
   represent the chunk's meaning.
5. Chroma stores the vector together with the document ID, filename, page, and
   other metadata.

When a user asks something, the same embedding model converts the question to a
vector. Chroma finds nearby vectors, which should correspond to passages with
similar meaning.

## 4. What is an embedding?

An embedding is a numeric representation of text. Similar ideas tend to have
vectors that are close together, even if they do not use exactly the same
words. For example, a question about a "data store" may find a passage that
uses the word "database."

This project supports a small local SentenceTransformer model and Gemini
embeddings. Both document chunks and questions must use a compatible model;
changing the model means rebuilding the existing index.

## 5. What is an agent in this project?

The agent is a loop with a small, fixed list of actions. At each step, the
planner returns JSON describing one next action. The backend validates it,
runs the matching Python function, records a summary, and asks the planner
what to do next. The loop stops when the planner says to answer or when it
reaches five steps.

The four tools are:

- `search_documents`: finds evidence passages in one or more chosen PDFs.
- `get_document_info`: reports which PDFs have been indexed.
- `compare_documents`: checks for relevant evidence in at least two PDFs.
- `rewrite_search_query`: improves a search phrase once if the first retrieval
  was poor.

This is a lightweight tool-planning agent. It does not let the model run Python
or issue arbitrary database commands. Using plain JSON output keeps the
implementation compatible with the text-generation APIs from Ollama, Gemini,
and OpenAI.

## 6. How are answers grounded?

The final model call receives document excerpts with filename and page labels.
The prompt says the excerpts are untrusted reference data, not instructions,
and asks for citations such as `[guide.pdf, p. 3]`. The API also returns each
source separately, and the UI lets the user expand the excerpt.

If no passage was retrieved, the backend returns "I don't know based on the
document." It does not ask the model to guess from outside knowledge. Citations
help users verify an answer, but they are not a mathematical proof that every
sentence is correct.

## 7. How do follow-up questions work?

The browser creates a random session ID and sends it with each question. The
backend stores a small, bounded history for each session. Recent user questions
can help the system understand phrases such as "What about its cost?" The
assistant's earlier answer may appear as context for the planner, but it is
marked unverified and is never treated as document evidence.

This is deliberately a simple portfolio implementation: session history is
kept in memory, so it is lost when the backend restarts and is not shared
between multiple backend processes.

## 8. Why use multiple PDFs and persistent storage?

Each uploaded PDF receives a unique ID. Every Chroma chunk stores that ID, so
search can include all PDFs or filter to the documents the user selected.
Deleting a PDF removes its chunks and saved file. A SHA-256 digest prevents
indexing the exact same PDF contents repeatedly.

Chroma and the uploaded PDFs live under one data directory. Local runs keep it
on disk, while Docker Compose mounts it as a named volume so restarts do not
erase the library.

## 9. Why FastAPI and React?

FastAPI provides typed HTTP endpoints, request validation, and generated API
documentation. React keeps the chat, file list, selected documents, and current
conversation interactive. Vite makes frontend development and production
bundling straightforward.

The API keeps the original `/upload` and `/ask` behavior, including the `answer`
and `sources` response fields. New agent metadata and a session ID are additive
fields, so older callers that ignore them can continue to use those endpoints.

## 10. What would you improve for production?

The current application is intended for a single-user demo, not a public,
multi-tenant service. A production version should add authentication and
per-user authorization, shared TTL-based conversation storage, backups, rate
limits, monitoring, and stronger operational controls. Other improvements
include OCR, streamed answers, more rigorous retrieval evaluation, hybrid
keyword/vector search, and citation checks.

The agent could also use provider-native structured tool calling or a workflow
framework if the product needs more complex branching. For this MVP, a bounded
JSON planner is easier to understand and test.

## 11. Sample interview explanation

> "I built a PDF question-answering app with both standard and agentic RAG. On
> upload, FastAPI validates each PDF, extracts text page by page, chunks it,
> embeds the chunks, and stores them in persistent Chroma with source metadata.
> Standard mode always retrieves first. Agent mode lets a bounded planner
> choose from four safe tools, and the backend logs each action. Both modes give
> the language model retrieved excerpts as untrusted evidence, return page
> citations, and fall back safely if there is no evidence. I kept the provider
> interface simple so Ollama, Gemini, and OpenAI can all be used, and used
> session IDs for short-lived follow-up context. The main trade-off is that
> memory is process-local and the app does not yet have authentication, which
> is acceptable for a portfolio MVP but not a multi-user production service."

## 12. Questions to practice

1. Why can semantic search find useful text when words do not match exactly?
2. What information is stored next to each vector and why?
3. Why should document text be treated as untrusted?
4. How does the app avoid comparing documents without evidence from both?
5. What happens if the embedding model changes?
6. What risks come from keeping chat history only in memory?
7. Why is the agent limited to five steps and one query rewrite?
8. What security and reliability work would you add before public deployment?
