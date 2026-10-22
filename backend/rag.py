import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from uuid import uuid4

import chromadb
from pypdf import PdfReader

from backend.embeddings import embed_query, embed_texts
from backend.llm import UNKNOWN_ANSWER, generate_answer


DATA_DIR = Path(os.getenv("DATA_DIR", Path(__file__).parent / "data"))
COLLECTION_NAME = "documents"
index_lock = RLock()
client = None
collection = None


def configure_storage(path: str | Path | None = None) -> None:
    """Initialize the persistent production index or an isolated test index."""
    global client, collection
    with index_lock:
        if str(path) == ":memory:":
            client = chromadb.EphemeralClient()
        else:
            client = chromadb.PersistentClient(path=str(path or DATA_DIR / "chroma"))
        collection = client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )


configure_storage()


def load_pdf(pdf_path: str | Path) -> list[tuple[int, str]]:
    reader = PdfReader(pdf_path)
    if reader.is_encrypted:
        raise ValueError("Password-protected PDFs are not supported.")
    pages = []
    for page_number, page in enumerate(reader.pages, start=1):
        text = page.extract_text()
        if text and text.strip():
            pages.append((page_number, text))
    return pages


def create_chunks(text: str, chunk_size: int = 500, chunk_overlap: int = 100) -> list[str]:
    if chunk_size <= 0 or chunk_overlap < 0 or chunk_overlap >= chunk_size:
        raise ValueError("Chunk size must be positive and overlap smaller than chunk size.")
    step = chunk_size - chunk_overlap
    return [text[index:index + chunk_size] for index in range(0, len(text), step)]


def _metadata_rows() -> list[dict]:
    with index_lock:
        if collection.count() == 0:
            return []
        result = collection.get(include=["metadatas"])
    return result["metadatas"] or []


def list_documents() -> list[dict]:
    documents: dict[str, dict] = {}
    for metadata in _metadata_rows():
        doc_id = metadata["document_id"]
        record = documents.setdefault(doc_id, {
            "document_id": doc_id,
            "filename": metadata["filename"],
            "page_count": metadata["page_count"],
            "chunk_count": 0,
            "indexed_at": metadata["indexed_at"],
        })
        record["chunk_count"] += 1
    return sorted(documents.values(), key=lambda item: item["indexed_at"])


def get_document_info() -> dict:
    documents = list_documents()
    return {"count": len(documents), "documents": documents}


def find_duplicate(content_hash: str) -> dict | None:
    with index_lock:
        result = collection.get(
            where={"content_hash": content_hash},
            include=["metadatas"],
        )
    if result["metadatas"]:
        document_id = result["metadatas"][0]["document_id"]
        document = next(
            item for item in list_documents()
            if item["document_id"] == document_id
        )
        return {**document, "content_hash": content_hash}
    return None


def index_document(
    pdf_path: str | Path,
    filename: str | None = None,
    document_id: str | None = None,
) -> dict:
    filename = filename or Path(pdf_path).name
    try:
        reader = PdfReader(pdf_path)
        if reader.is_encrypted:
            raise ValueError("Password-protected PDFs are not supported.")
        page_count = len(reader.pages)
        pages = []
        for page_number, page in enumerate(reader.pages, start=1):
            text = page.extract_text()
            if text and text.strip():
                pages.append((page_number, text))
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(
            "Could not read this PDF. It may be damaged or password-protected."
        ) from exc

    chunks: list[str] = []
    metadatas: list[dict] = []
    content_hash = hashlib.sha256(Path(pdf_path).read_bytes()).hexdigest()
    duplicate = find_duplicate(content_hash)
    if duplicate:
        return {
            **duplicate,
            "chunks_stored": duplicate["chunk_count"],
            "duplicate": True,
        }

    document_id = document_id or uuid4().hex
    indexed_at = datetime.now(timezone.utc).isoformat()
    for page_number, text in pages:
        for chunk in create_chunks(text):
            if chunk.strip():
                chunks.append(chunk)
                metadatas.append({
                    "document_id": document_id,
                    "filename": filename,
                    "page": page_number,
                    "page_count": page_count,
                    "indexed_at": indexed_at,
                    "content_hash": content_hash,
                })
    if not chunks:
        raise ValueError("This PDF has no extractable text. Scanned PDFs need OCR first.")

    embeddings = embed_texts(chunks)
    with index_lock:
        duplicate = find_duplicate(content_hash)
        if duplicate:
            return {
                **duplicate,
                "chunks_stored": duplicate["chunk_count"],
                "duplicate": True,
            }
        try:
            batch_size = client.get_max_batch_size()
            for start in range(0, len(chunks), batch_size):
                end = min(start + batch_size, len(chunks))
                collection.add(
                    ids=[f"{document_id}:{index}" for index in range(start, end)],
                    documents=chunks[start:end],
                    embeddings=embeddings[start:end],
                    metadatas=metadatas[start:end],
                )
        except Exception:
            collection.delete(where={"document_id": document_id})
            raise

    return {
        "document_id": document_id,
        "filename": filename,
        "page_count": page_count,
        "chunks_stored": len(chunks),
        "duplicate": False,
        "indexed_at": indexed_at,
    }


def delete_document(document_id: str) -> bool:
    with index_lock:
        matching = collection.get(
            where={"document_id": document_id},
            include=[],
        )
        if not matching["ids"]:
            return False
        collection.delete(where={"document_id": document_id})
        return True


def search_documents(
    query: str,
    document_ids: list[str] | None = None,
    limit: int = 4,
) -> list[dict]:
    query = query.strip()
    if not query:
        raise ValueError("Search query must not be empty.")
    if limit < 1:
        raise ValueError("Search result limit must be positive.")
    if document_ids is not None and not document_ids:
        return []
    query_embedding = embed_query(query)
    with index_lock:
        if collection.count() == 0:
            return []
        where = {"document_id": {"$in": document_ids}} if document_ids is not None else None
        count = collection.count()
        if count == 0:
            return []
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=min(limit, count),
            where=where,
            include=["documents", "metadatas", "distances"],
        )
    documents = results["documents"][0]
    metadatas = results["metadatas"][0]
    distances = results["distances"][0]
    return [
        {
            "document_id": metadata["document_id"],
            "filename": metadata["filename"],
            "page": metadata["page"],
            "text": text,
            "distance": float(distance),
        }
        for text, metadata, distance in zip(documents, metadatas, distances)
    ]


def compare_documents(
    query: str,
    document_ids: list[str] | None = None,
    limit: int = 8,
) -> dict:
    results = search_documents(query, document_ids=document_ids, limit=limit)
    grouped: dict[str, list[dict]] = {}
    for result in results:
        grouped.setdefault(result["document_id"], []).append(result)
    if len(grouped) < 2:
        return {
            "available": False,
            "message": "A comparison requires relevant passages from at least two documents.",
            "passages": results,
        }
    return {"available": True, "passages": results}


def format_context(sources: list[dict]) -> str:
    return "\n\n".join(
        f"[{source['filename']}, p. {source['page']}]\n"
        f"<untrusted_excerpt>\n{source['text']}\n</untrusted_excerpt>"
        for source in sources
    )


def ask_rag(
    question: str,
    document_ids: list[str] | None = None,
    history: list[dict[str, str]] | None = None,
) -> dict:
    question = question.strip()
    if not question:
        raise ValueError("Question must not be empty.")
    if not list_documents():
        raise ValueError("No document is indexed. Upload a PDF first.")
    retrieval_query = question
    if history:
        previous_questions = " ".join(turn["question"] for turn in history[-2:])
        retrieval_query = f"{previous_questions} {question}".strip()
    sources = search_documents(retrieval_query, document_ids=document_ids)
    answer = (
        generate_answer(format_context(sources), question, history)
        if sources
        else UNKNOWN_ANSWER
    )
    return {
        "answer": answer,
        "sources": sources,
    }
