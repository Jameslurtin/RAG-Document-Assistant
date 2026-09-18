from pathlib import Path
from threading import Lock
from uuid import uuid4

from pypdf import PdfReader
import chromadb
from backend.embeddings import embed_texts, embed_query
from backend.llm import generate_answer

client = chromadb.Client()
collection = None
index_lock = Lock()


def load_pdf(pdf_path):
    reader = PdfReader(pdf_path)

    pages = []

    for page_number, page in enumerate(reader.pages, start=1):
        text = page.extract_text()

        if text and text.strip():
            pages.append((page_number, text))

    return pages


def create_chunks(text):
    chunk_size = 500
    chunk_overlap = 100
    step = chunk_size - chunk_overlap

    chunks = []

    for i in range(0, len(text), step):
        chunk = text[i:i + chunk_size]
        chunks.append(chunk)

    return chunks


def index_document(pdf_path, filename=None):
    """Replace the active index only after the new PDF has been indexed."""
    global collection
    filename = filename or Path(pdf_path).name
    try:
        pages = load_pdf(pdf_path)
    except Exception as exc:
        raise ValueError("Could not read this PDF. It may be damaged or password-protected.") from exc

    chunks = []
    metadatas = []
    for page_number, text in pages:
        for chunk in create_chunks(text):
            if chunk.strip():
                chunks.append(chunk)
                metadatas.append({"filename": filename, "page": page_number})
    if not chunks:
        raise ValueError("This PDF has no extractable text. Scanned PDFs need OCR first.")

    # Keep replacement and retrieval from accessing different document versions.
    with index_lock:
        embeddings = embed_texts(chunks)
        replacement = client.create_collection(
            name=f"document_{uuid4().hex}", embedding_function=None
        )
        try:
            batch_size = client.get_max_batch_size()
            for start in range(0, len(chunks), batch_size):
                end = min(start + batch_size, len(chunks))
                replacement.add(
                    ids=[f"chunk_{i}" for i in range(start, end)],
                    documents=chunks[start:end],
                    embeddings=embeddings[start:end],
                    metadatas=metadatas[start:end],
                )
            if collection is not None:
                client.delete_collection(collection.name)
        except Exception:
            client.delete_collection(replacement.name)
            raise
        collection = replacement
        return {"filename": filename, "chunks_stored": len(chunks)}


def ask_rag(question: str):
    question = question.strip()
    if not question:
        raise ValueError("Question must not be empty.")
    with index_lock:
        if collection is None:
            raise ValueError("No document is indexed. Upload a PDF first.")
        question_embedding = embed_query(question)
        results = collection.query(
            query_embeddings=[question_embedding],
            n_results=min(4, collection.count()),
            include=["documents", "metadatas"],
        )

    context = "\n\n".join(results["documents"][0])

    answer = generate_answer(context, question)

    sources = [
        {"filename": metadata["filename"], "page": metadata["page"], "text": text}
        for text, metadata in zip(results["documents"][0], results["metadatas"][0])
    ]
    return {"answer": answer, "sources": sources}
