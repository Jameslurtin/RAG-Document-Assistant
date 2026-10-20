import logging
import os
from collections.abc import Callable
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import ollama
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from google.genai.errors import APIError as GeminiAPIError
from openai import APIConnectionError, APIError
from pydantic import BaseModel, Field, field_validator

from backend.agent import ask_agent
from backend.memory import conversation_memory
from backend.rag import DATA_DIR, ask_rag, delete_document, index_document, list_documents


app = FastAPI(title="RAG Document Assistant")
logger = logging.getLogger(__name__)
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
DOCUMENTS_DIR = DATA_DIR / "documents"

allowed_origins = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}
frontend_origin = os.getenv("FRONTEND_ORIGIN", "").strip()
if frontend_origin:
    allowed_origins.add(frontend_origin.rstrip("/"))

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(allowed_origins),
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)


class QuestionRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    session_id: str | None = None
    document_ids: list[str] | None = Field(default=None, max_length=100)

    @field_validator("question")
    @classmethod
    def question_not_empty(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Question must not be empty.")
        return value

    @field_validator("session_id")
    @classmethod
    def session_id_is_uuid(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        try:
            return UUID(value).hex
        except ValueError as exc:
            raise ValueError("session_id must be a UUID.") from exc

    @field_validator("document_ids")
    @classmethod
    def document_ids_are_uuids(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        try:
            return list(dict.fromkeys(UUID(value).hex for value in values))
        except ValueError as exc:
            raise ValueError("document_ids must contain document UUIDs.") from exc


def _session_id(request: QuestionRequest) -> str:
    return request.session_id or uuid4().hex


def _run_question(request: QuestionRequest, handler: Callable[..., dict]) -> dict:
    session_id = _session_id(request)
    history = conversation_memory.get(session_id)
    result = handler(
        request.question,
        document_ids=request.document_ids,
        history=history,
    )
    result["session_id"] = session_id
    conversation_memory.add(session_id, request.question, result["answer"])
    return result


def _raise_model_http_error(exc: Exception) -> None:
    if isinstance(exc, ValueError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if isinstance(exc, (ConnectionError, httpx.RequestError, APIConnectionError)):
        raise HTTPException(
            status_code=503,
            detail="The language model service is unavailable.",
        ) from exc
    if isinstance(exc, (ollama.ResponseError, APIError, GeminiAPIError)):
        raise HTTPException(
            status_code=502,
            detail="The language model service could not generate an answer.",
        ) from exc
    logger.exception("Question processing failed")
    raise HTTPException(
        status_code=500,
        detail="Could not answer the question. Please try again.",
    ) from exc


@app.get("/")
def home():
    return {"message": "RAG Document Assistant API is running"}


@app.get("/documents")
def get_documents():
    return {"documents": list_documents()}


@app.post("/ask")
def ask_question(request: QuestionRequest):
    try:
        return _run_question(request, ask_rag)
    except HTTPException:
        raise
    except Exception as exc:
        _raise_model_http_error(exc)


@app.post("/agent/ask")
def ask_agent_question(request: QuestionRequest):
    try:
        return _run_question(request, ask_agent)
    except HTTPException:
        raise
    except Exception as exc:
        _raise_model_http_error(exc)


def _save_and_index(file: UploadFile) -> dict:
    filename = Path((file.filename or "").replace("\\", "/")).name
    if not filename or Path(filename).suffix.lower() != ".pdf":
        raise HTTPException(status_code=415, detail="Only PDF files are accepted.")

    DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)
    document_id = uuid4().hex
    file_path = DOCUMENTS_DIR / f"{document_id}.pdf"
    try:
        total = 0
        header = b""
        with file_path.open("wb") as saved_file:
            while chunk := file.file.read(1024 * 1024):
                if not header:
                    header = chunk[:1024]
                    if b"%PDF-" not in header:
                        raise HTTPException(
                            status_code=415,
                            detail="The uploaded file is not a valid PDF.",
                        )
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"PDFs must be no larger than {MAX_UPLOAD_BYTES} bytes.",
                    )
                saved_file.write(chunk)
        if total == 0:
            raise HTTPException(status_code=422, detail="The uploaded PDF is empty.")

        result = index_document(
            file_path,
            filename=filename,
            document_id=document_id,
        )
        if result.get("duplicate"):
            file_path.unlink(missing_ok=True)
            result.pop("content_hash", None)
            return {
                **result,
                "chunks_stored": result["chunk_count"],
                "duplicate": True,
            }
        return result
    except HTTPException:
        file_path.unlink(missing_ok=True)
        raise
    except ValueError as exc:
        file_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        file_path.unlink(missing_ok=True)
        logger.exception("PDF indexing failed")
        raise HTTPException(
            status_code=500,
            detail="Could not save or index the PDF. Please try again.",
        ) from exc


@app.post("/upload")
def upload_pdf(
    file: UploadFile | None = File(default=None),
    files: list[UploadFile] | None = File(default=None),
):
    uploads = ([file] if file is not None else []) + (files or [])
    if not uploads:
        raise HTTPException(status_code=422, detail="Upload at least one PDF file.")

    results = []
    errors = []
    try:
        for upload in uploads:
            try:
                results.append(_save_and_index(upload))
            except HTTPException as exc:
                if len(uploads) == 1:
                    raise
                errors.append({
                    "filename": upload.filename or "unknown.pdf",
                    "detail": exc.detail,
                    "status": exc.status_code,
                })
    finally:
        for upload in uploads:
            upload.file.close()

    if not results:
        status = errors[0]["status"] if errors else 422
        raise HTTPException(
            status_code=status,
            detail="No PDFs could be indexed: " + "; ".join(error["detail"] for error in errors),
        )
    response = {
        "documents": results,
        "message": "PDF upload and indexing completed.",
    }
    if errors:
        response["errors"] = errors
    if len(results) == 1 and len(uploads) == 1:
        response.update(results[0])
        response["message"] = "PDF uploaded and indexed successfully"
    return response


@app.delete("/documents/{document_id}")
def remove_document(document_id: str):
    try:
        normalized_id = UUID(document_id).hex
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Invalid document ID.") from exc
    if not delete_document(normalized_id):
        raise HTTPException(status_code=404, detail="Document not found.")
    path = DOCUMENTS_DIR / f"{normalized_id}.pdf"
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        logger.exception("Indexed document file cleanup failed")
        raise HTTPException(
            status_code=500,
            detail="The document was removed from search but its stored PDF could not be deleted.",
        ) from exc
    return {"document_id": normalized_id, "message": "Document deleted successfully."}
