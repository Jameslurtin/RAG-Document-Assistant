from collections import deque
from threading import RLock


class ConversationMemory:
    def __init__(self, max_sessions: int = 1000, max_turns: int = 8) -> None:
        self.max_sessions = max_sessions
        self.max_turns = max_turns
        self._sessions: dict[str, deque[dict[str, str]]] = {}
        self._lock = RLock()

    def get(self, session_id: str) -> list[dict[str, str]]:
        with self._lock:
            turns = self._sessions.get(session_id)
            return list(turns) if turns else []

    def add(self, session_id: str, question: str, answer: str) -> None:
        with self._lock:
            if session_id not in self._sessions and len(self._sessions) >= self.max_sessions:
                oldest = next(iter(self._sessions))
                del self._sessions[oldest]
            turns = self._sessions.setdefault(
                session_id,
                deque(maxlen=self.max_turns),
            )
            turns.append({
                "question": question[:1000],
                "answer": answer[:3000],
            })


conversation_memory = ConversationMemory()
