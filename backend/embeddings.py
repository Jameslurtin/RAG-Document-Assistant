"""Embedding settings are fixed until restart; the in-memory index resets then too."""
import os
from functools import lru_cache

from google import genai
from google.genai import types


_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "local").strip().lower()
_GEMINI_MODEL = os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001").strip()


@lru_cache(maxsize=1)
def _local_model():
    # Import only when needed: Gemini deployments do not need PyTorch.
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise ValueError(
            "Local embeddings require backend/requirements-local.txt."
        ) from exc
    return SentenceTransformer("all-MiniLM-L6-v2")


def _embed(texts: list[str], task_type: str) -> list[list[float]]:
    if _PROVIDER not in {"local", "gemini"}:
        raise ValueError(f"Unsupported embedding provider: {_PROVIDER}")
    if not texts:
        return []
    if _PROVIDER == "local":
        return _local_model().encode(texts).tolist()

    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise ValueError("GEMINI_API_KEY is required when EMBEDDING_PROVIDER=gemini.")
    vectors = []
    with genai.Client(api_key=api_key) as client:
        # Bound each request instead of sending an entire PDF in one API call.
        for start in range(0, len(texts), 100):
            batch = texts[start:start + 100]
            response = client.models.embed_content(
                model=_GEMINI_MODEL,
                contents=batch,
                config=types.EmbedContentConfig(task_type=task_type),
            )
            if (not response.embeddings or len(response.embeddings) != len(batch)
                    or any(not item.values for item in response.embeddings)):
                raise ConnectionError("The embedding service returned incomplete embeddings.")
            vectors.extend([float(value) for value in item.values] for item in response.embeddings)
    return vectors


def embed_texts(texts: list[str]) -> list[list[float]]:
    return _embed(texts, "RETRIEVAL_DOCUMENT")


def embed_query(text: str) -> list[float]:
    return _embed([text], "RETRIEVAL_QUERY")[0]
