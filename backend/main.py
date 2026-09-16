import logging
from shutil import copyfileobj
from uuid import uuid4

import httpx
import ollama
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
from backend.rag import ask_rag, index_document
from pathlib import Path

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
logger = logging.getLogger(__name__)


class QuestionRequest(BaseModel):
    question: str

    @field_validator("question")
    @classmethod
    def question_not_empty(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Question must not be empty.")
        return value

DOCUMENTS_DIR = Path(__file__).parent / "documents" 

@app.get("/")
def home():
    return {"message": "RAG Document Assistant API is running"}

@app.post("/ask")
def ask_question(request: QuestionRequest):
    try:
        return ask_rag(request.question)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (ConnectionError, httpx.RequestError) as exc:
        raise HTTPException(
            status_code=503, detail="Cannot reach Ollama. Start Ollama with llama3.2 available."
        ) from exc
    except ollama.ResponseError as exc:
        raise HTTPException(
            status_code=502, detail="Ollama could not generate an answer. Check that llama3.2 is installed."
        ) from exc
    except Exception as exc:
        logger.exception("Question processing failed")
        raise HTTPException(status_code=500, detail="Could not answer the question. Please try again.") from exc


@app.post("/upload")
def upload_pdf(file: UploadFile = File(...)):
    file_path = None
    try:
        filename = Path((file.filename or "").replace("\\", "/")).name
        if not filename or Path(filename).suffix.lower() != ".pdf":
            raise HTTPException(status_code=415, detail="Only PDF files are accepted.")
        header = file.file.read(1024)
        file.file.seek(0)
        if not header:
            raise HTTPException(status_code=422, detail="The uploaded PDF is empty.")
        if b"%PDF-" not in header:
            raise HTTPException(status_code=415, detail="The uploaded file is not a valid PDF.")
        DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)
        # Never overwrite an existing upload or a user's local PDF.
        file_path = DOCUMENTS_DIR / f"{uuid4().hex}.pdf"
        with file_path.open("wb") as saved_file:
            copyfileobj(file.file, saved_file)
        result = index_document(file_path, filename=filename)
        return {**result, "message": "PDF uploaded and indexed successfully"}
    except HTTPException:
        raise
    except ValueError as exc:
        if file_path is not None:
            file_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        if file_path is not None:
            file_path.unlink(missing_ok=True)
        logger.exception("PDF indexing failed")
        raise HTTPException(status_code=500, detail="Could not save or index the PDF. Please try again.") from exc
    finally:
        file.file.close()
