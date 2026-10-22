import logging
import re
from time import perf_counter

from backend import rag
from backend.llm import UNKNOWN_ANSWER, generate_agent_action, generate_answer, rewrite_search_query


logger = logging.getLogger(__name__)
MAX_ITERATIONS = 5
MAX_REWRITES = 1


def _document_answer(documents: list[dict]) -> str:
    count = len(documents)
    if count == 0:
        return "You have uploaded 0 documents."
    filenames = ", ".join(item["filename"] for item in documents)
    noun = "document" if count == 1 else "documents"
    return f"You have uploaded {count} {noun}: {filenames}."


def _is_document_inventory_question(question: str) -> bool:
    normalized = re.sub(r"\s+", " ", question.lower()).strip()
    asks_for_count = any(
        phrase in normalized
        for phrase in ("how many", "number of", "count of", "total count", "total number")
    )
    asks_for_names = any(
        phrase in normalized
        for phrase in (
            "filename",
            "file name",
            "document name",
            "names of",
            "what are their names",
            "list",
            "which documents",
            "which files",
            "what documents",
            "what files",
        )
    )
    asks_about_uploads = any(
        phrase in normalized
        for phrase in ("uploaded", "upload", "have i got", "do i have")
    )
    about_documents = any(
        phrase in normalized for phrase in ("document", "file", "pdf")
    )
    return about_documents and (
        asks_for_count
        or asks_for_names
        or (asks_about_uploads and any(word in normalized for word in ("what", "which", "list", "show")))
    )


def ask_agent(
    question: str,
    document_ids: list[str] | None = None,
    history: list[dict[str, str]] | None = None,
) -> dict:
    question = question.strip()
    if not question:
        raise ValueError("Question must not be empty.")

    all_documents = rag.list_documents()
    selected_documents = (
        [item for item in all_documents if item["document_id"] in document_ids]
        if document_ids is not None
        else all_documents
    )
    tool_log: list[dict] = []
    sources: list[dict] = []
    source_keys: set[tuple] = set()
    tool_history: list[dict] = []
    rewrites = 0
    query = question
    comparison_requested = any(
        word in question.lower()
        for word in ("compare", "comparison", "contrast", "similar", "difference", "different", "versus", " vs ")
    )
    comparison_supported = False

    if _is_document_inventory_question(question):
        info = rag.get_document_info()
        documents = info["documents"]
        summary = f"Found {info['count']} indexed document(s)."
        logger.info("Agent tool executed", extra={"tool": "get_document_info"})
        return {
            "answer": _document_answer(documents),
            "sources": [],
            "agent": {
                "tools": [{"tool": "get_document_info", "summary": summary}],
                "iterations": 1,
                "max_iterations": MAX_ITERATIONS,
            },
        }

    if not selected_documents:
        has_documents = bool(all_documents)
        message = (
            "No selected documents are available for retrieval."
            if has_documents
            else "No uploaded documents are available for retrieval."
        )
        tool_log.append({
            "tool": "get_document_info",
            "summary": message,
        })
        logger.info("Agent tool executed", extra={"tool": "get_document_info"})
        asks_about_documents = any(
            word in question.lower() for word in ("document", "file", "upload")
        )
        answer = _document_answer([]) if asks_about_documents and not has_documents else (
            message if asks_about_documents else UNKNOWN_ANSWER
        )
        return {
            "answer": answer,
            "sources": [],
            "agent": {"tools": tool_log, "iterations": 1, "max_iterations": MAX_ITERATIONS},
        }

    for iteration in range(1, MAX_ITERATIONS + 1):
        action = generate_agent_action(
            question,
            selected_documents,
            tool_history,
            history,
        )
        name = action["action"]
        if comparison_requested and not comparison_supported and (
            (not tool_history and name != "compare_documents")
            or (
                tool_history
                and name not in {
                    "compare_documents",
                    "rewrite_search_query",
                    "answer",
                }
            )
        ):
            name = "compare_documents"
        started = perf_counter()
        summary = ""

        if name == "get_document_info":
            info = rag.get_document_info()
            available = [
                item for item in info["documents"]
                if item["document_id"] in {doc["document_id"] for doc in selected_documents}
            ]
            summary = f"Found metadata for {len(available)} selected document(s)."
            tool_history.append({"tool": name, "summary": summary})
            tool_log.append({"tool": name, "summary": summary})
            logger.info("Agent tool executed", extra={"tool": name, "iteration": iteration})
            answer = _document_answer(available)
            return {
                "answer": answer,
                "sources": [],
                "agent": {
                    "tools": tool_log,
                    "iterations": iteration,
                    "max_iterations": MAX_ITERATIONS,
                },
            }

        if name == "rewrite_search_query":
            if rewrites >= MAX_REWRITES:
                summary = "Rewrite limit reached; no additional rewrite was run."
                tool_history.append({"tool": "rewrite_search_query", "summary": summary})
                tool_log.append({"tool": "rewrite_search_query", "summary": summary})
                continue
            query = rewrite_search_query(action.get("query") or question, history)
            rewrites += 1
            summary = f"Rewrote the retrieval query (retry {rewrites}/{MAX_REWRITES})."
            tool_history.append({
                "tool": name,
                "summary": summary,
                "query": query,
            })

        elif name == "compare_documents":
            comparison_requested = True
            result = rag.compare_documents(
                action.get("query") or question,
                [doc["document_id"] for doc in selected_documents],
            )
            sources_to_add = result["passages"]
            summary = (
                f"Retrieved evidence from {len({item['document_id'] for item in sources_to_add})} "
                f"document(s); comparison "
                f"{'is available' if result['available'] else 'needs evidence from another document'}."
            )
            comparison_supported = comparison_supported or result["available"]
            for source in sources_to_add:
                key = (source["document_id"], source["page"], source["text"])
                if key not in source_keys:
                    source_keys.add(key)
                    sources.append(source)
            tool_history.append({"tool": name, "summary": summary})

        elif name == "search_documents":
            query = action.get("query") or query
            results = rag.search_documents(
                query,
                [doc["document_id"] for doc in selected_documents],
            )
            summary = f"Retrieved {len(results)} relevant passage(s)."
            for source in results:
                key = (source["document_id"], source["page"], source["text"])
                if key not in source_keys:
                    source_keys.add(key)
                    sources.append(source)
            tool_history.append({"tool": name, "summary": summary, "query": query})

        elif name == "answer":
            if not sources or (comparison_requested and not comparison_supported):
                answer = UNKNOWN_ANSWER
            else:
                answer = generate_answer(
                    rag.format_context(sources),
                    question,
                    history,
                )
            return {
                "answer": answer,
                "sources": sources,
                "agent": {
                    "tools": tool_log,
                    "iterations": iteration,
                    "max_iterations": MAX_ITERATIONS,
                },
            }

        duration_ms = round((perf_counter() - started) * 1000)
        tool_log.append({
            "tool": name,
            "summary": summary,
            "duration_ms": duration_ms,
        })
        logger.info(
            "Agent tool executed",
            extra={"tool": name, "iteration": iteration, "duration_ms": duration_ms},
        )

    answer = (
        generate_answer(rag.format_context(sources), question, history)
        if sources and (not comparison_requested or comparison_supported)
        else UNKNOWN_ANSWER
    )
    return {
        "answer": answer,
        "sources": sources,
        "agent": {
            "tools": tool_log,
            "iterations": MAX_ITERATIONS,
            "max_iterations": MAX_ITERATIONS,
        },
    }
