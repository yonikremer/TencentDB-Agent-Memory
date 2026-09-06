"""TencentDB Agent Memory v3 Python SDK — Strict isolation data plane client.

Differences with v2
-----------

- At construction, ``team_id`` / ``agent_id`` / ``user_id`` are **required**; missing any results in ``ParamError``.
- ``session_id`` rules:
    - ``add_conversation`` is **required** for writing (either construction or invocation, one or the other), and missing it results in ``ValueError`` —
      to prevent the server from silently merging writes without a session into the default bucket, causing data to be mixed with other callers.
    - Read interfaces (query / search / count / delete) are optional: if provided, they are scoped by session;
      if missing, they are aggregated across sessions by (team, agent, user) (full-view semantics at the agent dimension,
      For governance panel features such as layer-counts, cross-session L0/L1 lists, etc.).
    - L2/L3 are inherently team+agent-level profile aggregations and do not consume session_id.
- HTTP paths use ``/v3/...``; the server validates according to the same rules (422 if any of team/agent/user is missing).
- Non-L0–L3 interfaces such as ``offload`` / ``read_file`` are not exposed in v3 — continue using the v2 client.

>>> from tencentdb_agent_memory.v3 import MemoryClient
>>> # Typical usage: team+agent+user are defined at construction time, and session follows the specific session
>>> client = MemoryClient(
...     endpoint="https://memory.tencentyun.com",
...     api_key="sk-...",
...     service_id="mem-...",
...     team_id="t1", agent_id="a1", user_id="u1",
...     session_id="s1",   # Optional; when not provided, L0/L1 queries go through cross-session aggregation
... )
>>> client.add_conversation(messages=[{"role": "user", "content": "hi"}])
>>> client.read_scenario("notes/2026Q2.md")   # L2 does not read session_id
>>> # Pull the total number of all L0 conversations for a certain agent across sessions
>>> client.with_isolation(session_id=None).query_conversation(limit=1)
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .._http import Stub
from .._v3_http import AsyncHttpStub, HttpStub
from ..errors import ParamError

logger = logging.getLogger(__name__)


_V3 = "/v3"
_UNSET = object()


def _strip_none(d: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def _normalize_delete_ids(
    field: str,
    raw: Optional[List[str]],
    max_items: int,
) -> Optional[List[str]]:
    """Normalize the id list for batch deletion: validate non-empty strings, deduplicate (preserve order), check the limit.

    Block destructive operation inputs at the client, exposing issues earlier than waiting for the server to return 400,
    and avoiding sending obviously invalid batch requests.

    :returns: the normalized list; returns None when ``raw`` is None (indicating "not provided").
    """
    if raw is None:
        return None
    if not isinstance(raw, (list, tuple)):
        raise ParamError(f"{field} must be a list of non-empty strings")
    if any(not isinstance(item, str) or not item.strip() for item in raw):
        raise ParamError(f"{field} must contain only non-empty strings")

    seen: Dict[str, None] = {}
    for item in raw:
        seen.setdefault(item.strip(), None)
    deduped = list(seen.keys())

    if len(deduped) > max_items:
        raise ParamError(f"{field} accepts at most {max_items} items, got {len(deduped)}")
    return deduped


def _validate_construction(team_id: str, agent_id: str, user_id: str) -> None:
    """v3 requires team+agent+user at construction time, any missing one immediately raises ParamError, avoiding exposing 422.

    session_id is not strictly validated at construction time (L2/L3 interfaces do not require it); it is validated separately when L0/L1 method calls are made.
    """
    missing = [
        name for name, val in (
            ("team_id", team_id),
            ("agent_id", agent_id),
            ("user_id", user_id),
        ) if not val
    ]
    if missing:
        raise ParamError(
            f"v3 MemoryClient requires non-empty {', '.join(missing)} at construction time"
        )


class _IsolationCtx:
    """Carrier for the v3 isolation context. Internal only; exposed via with_isolation()."""

    __slots__ = ("team_id", "agent_id", "user_id", "session_id", "task_id")

    def __init__(
        self,
        team_id: str,
        agent_id: str,
        user_id: str,
        session_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> None:
        self.team_id = team_id
        self.agent_id = agent_id
        self.user_id = user_id
        self.session_id = session_id
        self.task_id = task_id

    def base_body(self) -> Dict[str, Any]:
        """team + agent + user (+ optional task); excludes session_id. Used for L2/L3 calls."""
        body: Dict[str, Any] = {
            "team_id": self.team_id,
            "agent_id": self.agent_id,
            "user_id": self.user_id,
        }
        if self.task_id:
            body["task_id"] = self.task_id
        return body

    def resolve_session(self, override: Optional[str]) -> Optional[str]:
        """L0/L1 call: override > session_id at construction.

        v3 server session_id optional: if passed, converge by session, otherwise by (team,agent,user)
        Cross-session aggregation query/count ("agent dimension full view" semantics, used for governance panels and similar scenarios).
        This method returns the final effective session_id, or None if missing — the caller should handle None when it is
        Do not stuff the session_id field into the request body.
        """
        return override or self.session_id

    def resolve_session_for_write(self, override: Optional[str]) -> str:
        """Write path specific: ``add_conversation`` must get a non-empty session_id.

        raise ``ParamError`` —— avoid silently merging writes without a session on the server
        bucket, mixing with other callers' data. Read paths (query/search/count/
        delete）still goes through ``resolve_session``, allowing a default for cross-session aggregation.
        """
        sid = override or self.session_id
        if not sid:
            raise ParamError(
                "v3 MemoryClient.add_conversation requires session_id: "
                "pass it in the constructor or per call. "
                "Reads (query/search/count) may omit it to aggregate across sessions."
            )
        return sid


# ---------------------------------------------------------------------------
# Synchronous client
# ---------------------------------------------------------------------------

class MemoryClient:
    """v3 Sync Client — Strict isolation L0–L3 data plane (including count endpoint).

    Required fields: ``team_id`` / ``agent_id`` / ``user_id``.
    Optional fields: ``session_id`` (when not passed, all L0–L3 interfaces aggregate across sessions), ``task_id``,
    ``user_key`` (required for asset-level interfaces such as ``clear_chat_memory``).
    """

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        service_id: Optional[str] = None,
        *,
        team_id: str = "",
        agent_id: str = "",
        user_id: str = "",
        session_id: Optional[str] = None,
        task_id: Optional[str] = None,
        user_key: Optional[str] = None,
        timeout: float = 30,
        verify: bool = True,
        stub: Optional[Stub] = None,
    ) -> None:
        _validate_construction(team_id, agent_id, user_id)
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ParamError("service_id must be provided")
            # user_key optional: the kernel does not perform user-level authentication, but the front gateway/panel may need to
            # Caller identity, here maintaining the pass-through capability consistent with MetadataClient.
            self._stub = HttpStub(
                endpoint, api_key, service_id,
                timeout=timeout, verify=verify, user_key=user_key,
            )
        self._iso = _IsolationCtx(team_id, agent_id, user_id, session_id, task_id)

    # -- isolation overrides ------------------------------------------------

    def with_isolation(
        self,
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        session_id: Any = _UNSET,
        task_id: Any = _UNSET,
    ) -> "MemoryClient":
        """Return a clone sharing the transport with selected isolation fields overridden.

        Pass ``session_id=None`` or ``task_id=None`` to explicitly clear a bound
        value. Omitting either argument keeps the current value.
        """
        new_team = self._iso.team_id if team_id is None else team_id
        new_agent = self._iso.agent_id if agent_id is None else agent_id
        new_user = self._iso.user_id if user_id is None else user_id
        new_session = self._iso.session_id if session_id is _UNSET else session_id
        new_task = self._iso.task_id if task_id is _UNSET else task_id
        _validate_construction(new_team, new_agent, new_user)
        clone = object.__new__(MemoryClient)
        clone._stub = self._stub
        clone._iso = _IsolationCtx(new_team, new_agent, new_user, new_session, new_task)
        return clone

    # -- L0 Conversation ---------------------------------------------------
    # Write must include session_id (otherwise the server will silently insert into the default bucket, causing data mixing);
    # Read interface session_id is optional, and if missing, it aggregates across sessions.

    def add_conversation(
        self,
        messages: List[Dict[str, Any]],
        *,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/add`` — Write required session_id (either construct or call)."""
        return self._stub.post(
            f"{_V3}/conversation/add",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session_for_write(session_id),
                "messages": messages,
            }),
        )

    def query_conversation(
        self,
        *,
        session_id: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/query``"""
        return self._stub.post(
            f"{_V3}/conversation/query",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "limit": limit,
                "offset": offset,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def search_conversation(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        session_id: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/search``"""
        return self._stub.post(
            f"{_V3}/conversation/search",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "query": query,
                "limit": limit,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def delete_conversation(
        self,
        *,
        message_ids: Optional[List[str]] = None,
        session_ids: Optional[List[str]] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/delete`` — Batch delete L0.

        ``message_ids`` (≤5000) and ``session_ids`` (≤100) must be provided at least one, and can be provided simultaneously.

        Note scope: here **will not** fall back to the ``session_id`` at construction. Deletion is destructive
        operate, if like the read interface automatically attaching the default session, just want to delete a few by message_ids
        The caller may accidentally delete the entire session. To delete a session, ``session_ids`` must be explicitly passed.

        ``session_id`` (singular) is deprecated, retained only for backward compatibility with old callers, and will be merged into
        ``session_ids``。
        """
        normalized_messages = _normalize_delete_ids("message_ids", message_ids, 5000)
        normalized_sessions = _normalize_delete_ids("session_ids", session_ids, 100)

        if session_id is not None:
            if not isinstance(session_id, str) or not session_id.strip():
                raise ParamError("session_id must be a non-empty string")
            merged = list(normalized_sessions or [])
            if session_id.strip() not in merged:
                merged.append(session_id.strip())
            normalized_sessions = merged

        if not normalized_messages and not normalized_sessions:
            raise ParamError(
                "delete_conversation requires message_ids or session_ids "
                "(the constructor session_id is intentionally NOT used for deletes)"
            )

        return self._stub.post(
            f"{_V3}/conversation/delete",
            _strip_none({
                **self._iso.base_body(),
                "message_ids": normalized_messages,
                "session_ids": normalized_sessions,
            }),
        )

    def count_conversation(
        self,
        *,
        session_id: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/count`` — Same filters as query, only returns ``{total}``."""
        return self._stub.post(
            f"{_V3}/conversation/count",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    # -- L1 Atomic (session_id optional, aggregated across sessions if missing) -----------------

    def update_atomic(
        self,
        id: str,
        content: str,
        *,
        background: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/update``"""
        return self._stub.post(
            f"{_V3}/atomic/update",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "id": id,
                "content": content,
                "background": background,
            }),
        )

    def query_atomic(
        self,
        *,
        type: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/query``"""
        return self._stub.post(
            f"{_V3}/atomic/query",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "type": type,
                "limit": limit,
                "offset": offset,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def search_atomic(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        type: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/search``"""
        return self._stub.post(
            f"{_V3}/atomic/search",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "query": query,
                "limit": limit,
                "type": type,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def delete_atomic(
        self,
        ids: List[str],
        *,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/delete`` — ids required, up to 5000 entries per request."""
        normalized = _normalize_delete_ids("ids", ids, 5000)
        if not normalized:
            raise ParamError("delete_atomic requires a non-empty ids list")
        return self._stub.post(
            f"{_V3}/atomic/delete",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "ids": normalized,
            }),
        )

    def count_atomic(
        self,
        *,
        type: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/count`` — Same filters as query, only returns ``{total}``."""
        return self._stub.post(
            f"{_V3}/atomic/count",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "type": type,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    # -- L2 Scenario (team+agent level, no session_id needed) -------------------

    def list_scenarios(self, *, path_prefix: Optional[str] = None) -> Dict[str, Any]:
        """``POST /v3/scenario/ls``"""
        return self._stub.post(
            f"{_V3}/scenario/ls",
            _strip_none({**self._iso.base_body(), "path_prefix": path_prefix}),
        )

    def read_scenario(self, path: str) -> Dict[str, Any]:
        """``POST /v3/scenario/read``"""
        return self._stub.post(
            f"{_V3}/scenario/read",
            {**self._iso.base_body(), "path": path},
        )

    def write_scenario(
        self,
        path: str,
        content: str,
        *,
        summary: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/scenario/write``"""
        return self._stub.post(
            f"{_V3}/scenario/write",
            _strip_none({
                **self._iso.base_body(),
                "path": path,
                "content": content,
                "summary": summary,
            }),
        )

    def rm_scenario(self, path: str) -> Dict[str, Any]:
        """``POST /v3/scenario/rm``"""
        return self._stub.post(
            f"{_V3}/scenario/rm",
            {**self._iso.base_body(), "path": path},
        )

    def count_scenario(self, *, path_prefix: Optional[str] = None) -> Dict[str, Any]:
        """``POST /v3/scenario/count`` — Same filters as ls, only returns ``{total}``."""
        return self._stub.post(
            f"{_V3}/scenario/count",
            _strip_none({**self._iso.base_body(), "path_prefix": path_prefix}),
        )

    # -- L3 Core (team+agent level, no session_id needed) -----------------------

    def read_core(self) -> Dict[str, Any]:
        """``POST /v3/core/read``"""
        return self._stub.post(f"{_V3}/core/read", self._iso.base_body())

    def write_core(self, content: str) -> Dict[str, Any]:
        """``POST /v3/core/write``"""
        return self._stub.post(
            f"{_V3}/core/write",
            {**self._iso.base_body(), "content": content},
        )

    def count_core(self) -> Dict[str, Any]:
        """``POST /v3/core/count`` — Count the number of core memory files."""
        return self._stub.post(f"{_V3}/core/count", self._iso.base_body())

    # -- Chat Memory (asset-level) -----------------------------------------

    def clear_chat_memory(self, memory_ids: List[str]) -> Dict[str, Any]:
        """``POST /v3/chat-memory/clear`` — Clear all chat memory content, keep assets.

        Clear scope: L0 / L1 / L2 / L3 + vector + files.
        Retain content: ``memory_id``, Team/Agent ownership, Agent binding, ACL, Owner,
        Name, visibility — after clearing, the Agent continues to write with the original ``memory_id``, no rebuild needed.

        Unlike the L0/L1 deletion interface, this interface is a **asset-level** operation:

        * The scope is determined by ``memory_ids`` itself, and no isolation triples are used
        * If any ``memory_id`` does not exist or is not a chat_memory, the **entire batch is rejected**, and none are cleared
        * Idempotent: calling again after it has been cleared still returns success, with the count as 0

        Permissions: consistent with other deletion interfaces, the kernel does not perform user-level authorization. If "only Owner can clear" is needed
        The constraint, please go to the panel backend ``/api/v1/chat-memory/clear`` (where it will validate Owner).

        The failure item carries a ``retryable`` flag; when True, it means the server has automatically retried but still failed,
        and a subsequent retry can complete the residual content.

        :param memory_ids: asset ids to clear, 1–100 (auto deduplicated)
        """
        normalized = _normalize_delete_ids("memory_ids", memory_ids, 100)
        if not normalized:
            raise ParamError("clear_chat_memory requires a non-empty memory_ids list")
        # Note: no isolation triple -- scope is determined by memory_ids.
        return self._stub.post(f"{_V3}/chat-memory/clear", {"memory_ids": normalized})

    # -- Lifecycle ---------------------------------------------------------

    def close(self) -> None:
        self._stub.close()

    def __enter__(self) -> "MemoryClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


# ---------------------------------------------------------------------------
# Asynchronous client
# ---------------------------------------------------------------------------

class AsyncMemoryClient:
    """v3 Async Client — Strict isolation L0–L3 data plane (including count endpoint, async version).

    Consistent with the synchronized version: construct required team+agent+user; session_id is optional across all L0–L3
    (aggregate by (team,agent,user) across sessions when missing).
    """

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        service_id: Optional[str] = None,
        *,
        team_id: str = "",
        agent_id: str = "",
        user_id: str = "",
        session_id: Optional[str] = None,
        task_id: Optional[str] = None,
        user_key: Optional[str] = None,
        timeout: float = 30,
        verify: bool = True,
        stub: Optional[Stub] = None,
    ) -> None:
        _validate_construction(team_id, agent_id, user_id)
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ParamError("service_id must be provided")
            # user_key optional: the kernel does not validate it; the front gateway/panel may require the caller's identity.
            self._stub = AsyncHttpStub(
                endpoint, api_key, service_id,
                timeout=timeout, verify=verify, user_key=user_key,
            )
        self._iso = _IsolationCtx(team_id, agent_id, user_id, session_id, task_id)

    def with_isolation(
        self,
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        session_id: Any = _UNSET,
        task_id: Any = _UNSET,
    ) -> "AsyncMemoryClient":
        """Clone this client; pass ``None`` to clear a bound session/task."""
        new_team = self._iso.team_id if team_id is None else team_id
        new_agent = self._iso.agent_id if agent_id is None else agent_id
        new_user = self._iso.user_id if user_id is None else user_id
        new_session = self._iso.session_id if session_id is _UNSET else session_id
        new_task = self._iso.task_id if task_id is _UNSET else task_id
        _validate_construction(new_team, new_agent, new_user)
        clone = object.__new__(AsyncMemoryClient)
        clone._stub = self._stub
        clone._iso = _IsolationCtx(new_team, new_agent, new_user, new_session, new_task)
        return clone

    # -- L0 Conversation ---------------------------------------------------
    # Write must include session_id (otherwise the server will silently insert into the default bucket, causing data mixing);
    # Read interface session_id is optional, and if missing, it aggregates across sessions.

    async def add_conversation(
        self,
        messages: List[Dict[str, Any]],
        *,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/add`` — Write required session_id (either construct or call)."""
        return await self._stub.post(
            f"{_V3}/conversation/add",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session_for_write(session_id),
                "messages": messages,
            }),
        )

    async def query_conversation(
        self,
        *,
        session_id: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/conversation/query",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "limit": limit, "offset": offset,
                "time_start": time_start, "time_end": time_end,
            }),
        )

    async def search_conversation(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        session_id: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/conversation/search",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "query": query, "limit": limit,
                "time_start": time_start, "time_end": time_end,
            }),
        )

    async def delete_conversation(
        self,
        *,
        message_ids: Optional[List[str]] = None,
        session_ids: Optional[List[str]] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/conversation/delete`` (async). Semantics are the same as the synchronous version."""
        normalized_messages = _normalize_delete_ids("message_ids", message_ids, 5000)
        normalized_sessions = _normalize_delete_ids("session_ids", session_ids, 100)

        if session_id is not None:
            if not isinstance(session_id, str) or not session_id.strip():
                raise ParamError("session_id must be a non-empty string")
            merged = list(normalized_sessions or [])
            if session_id.strip() not in merged:
                merged.append(session_id.strip())
            normalized_sessions = merged

        if not normalized_messages and not normalized_sessions:
            raise ParamError(
                "delete_conversation requires message_ids or session_ids "
                "(the constructor session_id is intentionally NOT used for deletes)"
            )

        return await self._stub.post(
            f"{_V3}/conversation/delete",
            _strip_none({
                **self._iso.base_body(),
                "message_ids": normalized_messages,
                "session_ids": normalized_sessions,
            }),
        )

    async def count_conversation(
        self,
        *,
        session_id: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/conversation/count",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    # -- L1 Atomic (session_id optional, aggregated across sessions if missing) -----------------

    async def update_atomic(
        self,
        id: str,
        content: str,
        *,
        background: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/atomic/update",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "id": id, "content": content, "background": background,
            }),
        )

    async def query_atomic(
        self,
        *,
        type: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/atomic/query",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "type": type, "limit": limit, "offset": offset,
                "time_start": time_start, "time_end": time_end,
            }),
        )

    async def search_atomic(
        self,
        query: str,
        *,
        limit: Optional[int] = None,
        type: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/atomic/search",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "query": query, "limit": limit, "type": type,
                "time_start": time_start, "time_end": time_end,
            }),
        )

    async def delete_atomic(
        self,
        ids: List[str],
        *,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/atomic/delete`` (async). ids is required, up to 5000 entries per request."""
        normalized = _normalize_delete_ids("ids", ids, 5000)
        if not normalized:
            raise ParamError("delete_atomic requires a non-empty ids list")
        return await self._stub.post(
            f"{_V3}/atomic/delete",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "ids": normalized,
            }),
        )

    async def count_atomic(
        self,
        *,
        type: Optional[str] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/atomic/count",
            _strip_none({
                **self._iso.base_body(),
                "session_id": self._iso.resolve_session(session_id),
                "type": type,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    # -- L2 Scenario (team+agent level, no session_id needed) -------------------

    async def list_scenarios(self, *, path_prefix: Optional[str] = None) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/ls",
            _strip_none({**self._iso.base_body(), "path_prefix": path_prefix}),
        )

    async def read_scenario(self, path: str) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/read",
            {**self._iso.base_body(), "path": path},
        )

    async def write_scenario(
        self,
        path: str,
        content: str,
        *,
        summary: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/write",
            _strip_none({
                **self._iso.base_body(),
                "path": path, "content": content, "summary": summary,
            }),
        )

    async def rm_scenario(self, path: str) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/rm",
            {**self._iso.base_body(), "path": path},
        )

    async def count_scenario(self, *, path_prefix: Optional[str] = None) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/scenario/count",
            _strip_none({**self._iso.base_body(), "path_prefix": path_prefix}),
        )

    # -- L3 Core (team+agent level, no session_id needed) -----------------------

    async def read_core(self) -> Dict[str, Any]:
        return await self._stub.post(f"{_V3}/core/read", self._iso.base_body())

    async def write_core(self, content: str) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V3}/core/write",
            {**self._iso.base_body(), "content": content},
        )

    async def count_core(self) -> Dict[str, Any]:
        return await self._stub.post(f"{_V3}/core/count", self._iso.base_body())

    # -- Chat Memory (asset-level) -----------------------------------------

    async def clear_chat_memory(self, memory_ids: List[str]) -> Dict[str, Any]:
        """``POST /v3/chat-memory/clear`` (async). Same semantics as the synchronous version."""
        normalized = _normalize_delete_ids("memory_ids", memory_ids, 100)
        if not normalized:
            raise ParamError("clear_chat_memory requires a non-empty memory_ids list")
        # Note: no isolation triple -- scope is determined by memory_ids.
        return await self._stub.post(f"{_V3}/chat-memory/clear", {"memory_ids": normalized})

    async def close(self) -> None:
        await self._stub.close()

    async def __aenter__(self) -> "AsyncMemoryClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
