"""TencentDB Agent Memory v2 Python SDK — synchronous + asynchronous clients.

Exposes the v2 data-plane API (14 routes) over a Bearer-token authenticated
HTTP transport.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .._http import AsyncHttpStub, HttpStub, Stub
from ..cos import AsyncMemoryFileReader, AsyncStsCredentialManager, MemoryFileReader, StsCredentialManager

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_V2 = "/v2"


def _strip_none(d: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of *d* with ``None`` values removed."""
    return {k: v for k, v in d.items() if v is not None}


def _id_fields(
    team_id: Optional[str],
    agent_id: Optional[str],
    user_id: Optional[str],
    task_id: Optional[str],
) -> Dict[str, Any]:
    """Team memory 4 ID isolation fields, all optional.

    The server ``resolveIsolation`` prioritizes body fields, falling back to ``x-tdai-*`` headers if missing.
    See the IdFields component in docs/team-api-memory.yaml.
    """
    return _strip_none({
        "team_id": team_id,
        "agent_id": agent_id,
        "user_id": user_id,
        "task_id": task_id,
    })


# ---------------------------------------------------------------------------
# Synchronous client
# ---------------------------------------------------------------------------

class MemoryClient:
    """Synchronous client for the TencentDB Agent Memory v2 data-plane API.

    Example::

        from tencentdb_agent_memory import MemoryClient

        client = MemoryClient(
            endpoint="https://memory.tencentyun.com",
            api_key="sk-xxxxxxxx",
            service_id="mem-xxxxxxxx",
        )
        result = client.add_conversation("sess-1", [
            {"role": "user", "content": "hello"},
        ])
        print(result)  # {"accepted_ids": [...], "total_count": 1}

    Parameters
    ----------
    endpoint : str
        Base URL of the memory service.
    api_key : str
        Bearer token.
    service_id : str
        Memory instance ID (sent via ``x-tdai-service-id`` header).
    timeout : float
        Request timeout in seconds.
    stub : Stub | None
        Inject a custom transport (useful for testing).
    """

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        service_id: Optional[str] = None,
        *,
        timeout: float = 30,
        verify: bool = False,
        stub: Optional[Stub] = None,
    ) -> None:
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ValueError("service_id must be provided")
            self._stub = HttpStub(endpoint, api_key, service_id, timeout=timeout, verify=verify)

        # Memory file reader (lazy init on first read_file call)
        self._cos_reader: Optional[MemoryFileReader] = None
        self._sts_manager: Optional[StsCredentialManager] = None

    # -- L0 Conversation ---------------------------------------------------

    def add_conversation(
        self,
        session_id: str,
        messages: List[Dict[str, Any]],
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /conversation/add``"""
        return self._stub.post(
            f"{_V2}/conversation/add",
            {
                **_id_fields(team_id, agent_id, user_id, task_id),
                "session_id": session_id,
                "messages": messages,
            },
        )

    def query_conversation(
        self,
        *,
        session_id: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /conversation/query``"""
        return self._stub.post(
            f"{_V2}/conversation/query",
            _strip_none({
                **_id_fields(team_id, agent_id, user_id, task_id),
                "session_id": session_id,
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
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /conversation/search``"""
        return self._stub.post(
            f"{_V2}/conversation/search",
            _strip_none({
                **_id_fields(team_id, agent_id, user_id, task_id),
                "query": query,
                "limit": limit,
                "session_id": session_id,
                "time_start": time_start,
                "time_end": time_end,
            }),
        )

    def delete_conversation(
        self,
        *,
        message_ids: Optional[List[str]] = None,
        session_id: Optional[str] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /conversation/delete`` — Choose either *message_ids* or *session_id*."""
        return self._stub.post(
            f"{_V2}/conversation/delete",
            _strip_none({
                **_id_fields(team_id, agent_id, user_id, task_id),
                "message_ids": message_ids,
                "session_id": session_id,
            }),
        )

    # -- L1 Atomic ---------------------------------------------------------

    def update_atomic(
        self,
        id: str,
        content: str,
        *,
        background: Optional[str] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /atomic/update``"""
        return self._stub.post(
            f"{_V2}/atomic/update",
            _strip_none({
                **_id_fields(team_id, agent_id, user_id, task_id),
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
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /atomic/query``"""
        return self._stub.post(
            f"{_V2}/atomic/query",
            _strip_none({
                **_id_fields(team_id, agent_id, user_id, task_id),
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
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /atomic/search``"""
        return self._stub.post(
            f"{_V2}/atomic/search",
            _strip_none({
                **_id_fields(team_id, agent_id, user_id, task_id),
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
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /atomic/delete``"""
        return self._stub.post(
            f"{_V2}/atomic/delete",
            {
                **_id_fields(team_id, agent_id, user_id, task_id),
                "ids": ids,
            },
        )

    # -- L2 Scenario -------------------------------------------------------

    def list_scenarios(
        self,
        *,
        path_prefix: Optional[str] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /scenario/ls``"""
        return self._stub.post(
            f"{_V2}/scenario/ls",
            _strip_none({
                **_id_fields(team_id, agent_id, user_id, task_id),
                "path_prefix": path_prefix,
            }),
        )

    def read_scenario(
        self,
        path: str,
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /scenario/read``

        Returns dict with ``content``, ``created_at``, ``updated_at``.
        If the file does not exist, ``content`` will be ``None``.
        """
        return self._stub.post(
            f"{_V2}/scenario/read",
            {
                **_id_fields(team_id, agent_id, user_id, task_id),
                "path": path,
            },
        )

    def write_scenario(
        self,
        path: str,
        content: str,
        *,
        summary: Optional[str] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /scenario/write``"""
        return self._stub.post(
            f"{_V2}/scenario/write",
            _strip_none({
                **_id_fields(team_id, agent_id, user_id, task_id),
                "path": path,
                "content": content,
                "summary": summary,
            }),
        )

    def rm_scenario(
        self,
        path: str,
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /scenario/rm``"""
        return self._stub.post(
            f"{_V2}/scenario/rm",
            {
                **_id_fields(team_id, agent_id, user_id, task_id),
                "path": path,
            },
        )

    # -- L3 Core -----------------------------------------------------------

    def read_core(
        self,
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /core/read``

        Returns dict with ``content``, ``created_at``, ``updated_at``.
        If core memory has not been generated yet, ``content`` will be ``None``.
        """
        return self._stub.post(
            f"{_V2}/core/read",
            _id_fields(team_id, agent_id, user_id, task_id),
        )

    def write_core(
        self,
        content: str,
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /core/write``"""
        return self._stub.post(
            f"{_V2}/core/write",
            {
                **_id_fields(team_id, agent_id, user_id, task_id),
                "content": content,
            },
        )

    # -- Offload (Ingest + Compact + Query-MMD) ----------------------------

    def offload_ingest(
        self,
        session_id: str,
        tool_pairs: List[Dict[str, Any]],
        *,
        prompt: Optional[str] = None,
        recent_messages: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """``POST /v2/offload/ingest`` — Report tool call pairs to trigger asynchronous L1 processing.

        Can be used as fire-and-forget (ignore return value).

        Parameters
        ----------
        session_id : str
            Session ID.
        tool_pairs : list[dict]
            List of tool call pairs, each element containing ``tool_name``, ``tool_call_id``,
            ``params``, ``result``, ``timestamp``, and optionally ``duration_ms``.
        prompt : str, optional
            Latest user message, used for L1.5 task judgment.
        recent_messages : list[dict], optional
            List of recent historical messages (``role`` + ``content``) to assist L1 in extracting context.
        """
        return self._stub.post(
            f"{_V2}/offload/ingest",
            _strip_none({
                "session_id": session_id,
                "tool_pairs": tool_pairs,
                "prompt": prompt,
                "recent_messages": recent_messages,
            }),
        )

    def offload_compact(
        self,
        session_id: str,
        messages: List[Dict[str, Any]],
        ratio: float,
        total_tokens: int,
        *,
        context_window: Optional[int] = None,
        message_tokens: Optional[List[int]] = None,
    ) -> Dict[str, Any]:
        """``POST /v2/offload/compact`` — Perform server-side context compaction on messages.

        Parameters
        ----------
        session_id : str
            Session ID.
        messages : list[dict]
            Current complete conversation message list.
        ratio : float
            Current token usage ratio (used / context_window) to trigger compaction strategy judgment.
        total_tokens : int
            Total token count of the current complete context (including implicit overhead not in
            messages, such as system prompt, tool schemas, etc.). Used by the server to calculate fixed overhead and calibrate token estimation.
        context_window : int, optional
            Model context window size (token count).
        message_tokens : list[int], optional
            Token count for each message, providing this can skip server estimation to improve performance.

        Returns
        -------
        dict
            ``messages`` (compacted message list) + ``report`` (compaction report).
        """
        return self._stub.post(
            f"{_V2}/offload/compact",
            _strip_none({
                "session_id": session_id,
                "messages": messages,
                "ratio": ratio,
                "total_tokens": total_tokens,
                "context_window": context_window,
                "message_tokens": message_tokens,
            }),
        )

    def offload_query_mmd(
        self,
        session_id: str,
        *,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """``POST /v2/offload/query-mmd`` — Query the task flow chart (MMD file) of the session.

        Parameters
        ----------
        session_id : str
            Session ID.
        limit : int, optional
            Maximum number of MMD files to return. When ``limit=1``, it takes the fast path and only returns the currently active MMD.

        Returns
        -------
        dict
            ``mmds`` (list, each item contains ``filename``, ``content``, ``version``) +
            ``current_mmd`` (currently active MMD filename, or ``None`` if none exists).
        """
        return self._stub.post(
            f"{_V2}/offload/query-mmd",
            _strip_none({
                "session_id": session_id,
                "limit": limit,
            }),
        )

    # -- File read (memory pipeline artifacts) -----------------------------

    def read_file(self, path: str) -> str:
        """Read a memory pipeline artifact (e.g. ``persona.md``,
        ``scene_blocks/*.md``) by relative path.

        Parameters
        ----------
        path : str
            Relative path within the memory space, e.g.
            ``"scene_blocks/cooking-recipes.md"`` or ``"persona.md"``.

        Returns
        -------
        str
            File content.

        Raises
        ------
        TDAMError
            On 404 (not found), 403 (auth failure after retry), or other errors.
        """
        if self._cos_reader is None:
            self._sts_manager = StsCredentialManager(
                endpoint=self._stub.endpoint,
                api_key=self._stub.headers["Authorization"].removeprefix("Bearer "),
                service_id=self._stub.headers["x-tdai-service-id"],
            )
            self._cos_reader = MemoryFileReader(self._sts_manager)
        return self._cos_reader.read(path)

    # -- lifecycle ---------------------------------------------------------

    def close(self) -> None:
        if self._cos_reader is not None:
            self._cos_reader.close()
        self._stub.close()

    def __enter__(self) -> "MemoryClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


# ---------------------------------------------------------------------------
# Asynchronous client
# ---------------------------------------------------------------------------

class AsyncMemoryClient:
    """Asynchronous client for the TencentDB Agent Memory v2 data-plane API.

    Same API surface as :class:`MemoryClient` but all methods are coroutines.
    """

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        service_id: Optional[str] = None,
        *,
        timeout: float = 30,
        verify: bool = False,
    ) -> None:
        if not service_id:
            raise ValueError("service_id must be provided")
        self._stub = AsyncHttpStub(endpoint, api_key, service_id, timeout=timeout, verify=verify)

        # Memory file reader (lazy init)
        self._cos_reader: Optional[AsyncMemoryFileReader] = None
        self._sts_manager: Optional[AsyncStsCredentialManager] = None

    # -- L0 Conversation ---------------------------------------------------

    async def add_conversation(
        self, session_id: str, messages: List[Dict[str, Any]],
        *,
        team_id: Optional[str] = None, agent_id: Optional[str] = None,
        user_id: Optional[str] = None, task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/conversation/add",
            {**_id_fields(team_id, agent_id, user_id, task_id),
             "session_id": session_id, "messages": messages},
        )

    async def query_conversation(
        self, *, session_id: Optional[str] = None, limit: Optional[int] = None,
        offset: Optional[int] = None, time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        team_id: Optional[str] = None, agent_id: Optional[str] = None,
        user_id: Optional[str] = None, task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/conversation/query",
            _strip_none({**_id_fields(team_id, agent_id, user_id, task_id),
                         "session_id": session_id, "limit": limit, "offset": offset,
                         "time_start": time_start, "time_end": time_end}),
        )

    async def search_conversation(
        self, query: str, *, limit: Optional[int] = None,
        session_id: Optional[str] = None, time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        team_id: Optional[str] = None, agent_id: Optional[str] = None,
        user_id: Optional[str] = None, task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/conversation/search",
            _strip_none({**_id_fields(team_id, agent_id, user_id, task_id),
                         "query": query, "limit": limit, "session_id": session_id,
                         "time_start": time_start, "time_end": time_end}),
        )

    async def delete_conversation(
        self, *, message_ids: Optional[List[str]] = None,
        session_id: Optional[str] = None,
        team_id: Optional[str] = None, agent_id: Optional[str] = None,
        user_id: Optional[str] = None, task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/conversation/delete",
            _strip_none({**_id_fields(team_id, agent_id, user_id, task_id),
                         "message_ids": message_ids, "session_id": session_id}),
        )

    # -- L1 Atomic ---------------------------------------------------------

    async def update_atomic(
        self, id: str, content: str, *, background: Optional[str] = None,
        team_id: Optional[str] = None, agent_id: Optional[str] = None,
        user_id: Optional[str] = None, task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/atomic/update",
            _strip_none({**_id_fields(team_id, agent_id, user_id, task_id),
                         "id": id, "content": content, "background": background}),
        )

    async def query_atomic(
        self, *, type: Optional[str] = None, limit: Optional[int] = None,
        offset: Optional[int] = None, time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        team_id: Optional[str] = None, agent_id: Optional[str] = None,
        user_id: Optional[str] = None, task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/atomic/query",
            _strip_none({**_id_fields(team_id, agent_id, user_id, task_id),
                         "type": type, "limit": limit, "offset": offset,
                         "time_start": time_start, "time_end": time_end}),
        )

    async def search_atomic(
        self, query: str, *, limit: Optional[int] = None,
        type: Optional[str] = None, time_start: Optional[str] = None,
        time_end: Optional[str] = None,
        team_id: Optional[str] = None, agent_id: Optional[str] = None,
        user_id: Optional[str] = None, task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/atomic/search",
            _strip_none({**_id_fields(team_id, agent_id, user_id, task_id),
                         "query": query, "limit": limit, "type": type,
                         "time_start": time_start, "time_end": time_end}),
        )

    async def delete_atomic(
        self, ids: List[str], *,
        team_id: Optional[str] = None, agent_id: Optional[str] = None,
        user_id: Optional[str] = None, task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/atomic/delete",
            {**_id_fields(team_id, agent_id, user_id, task_id), "ids": ids},
        )

    # -- L2 Scenario -------------------------------------------------------

    async def list_scenarios(
        self, *, path_prefix: Optional[str] = None,
        team_id: Optional[str] = None, agent_id: Optional[str] = None,
        user_id: Optional[str] = None, task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/scenario/ls",
            _strip_none({**_id_fields(team_id, agent_id, user_id, task_id),
                         "path_prefix": path_prefix}),
        )

    async def read_scenario(
        self, path: str, *,
        team_id: Optional[str] = None, agent_id: Optional[str] = None,
        user_id: Optional[str] = None, task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /scenario/read`` — returns ``content: None`` if file does not exist."""
        return await self._stub.post(
            f"{_V2}/scenario/read",
            {**_id_fields(team_id, agent_id, user_id, task_id), "path": path},
        )

    async def write_scenario(
        self, path: str, content: str, *, summary: Optional[str] = None,
        team_id: Optional[str] = None, agent_id: Optional[str] = None,
        user_id: Optional[str] = None, task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/scenario/write",
            _strip_none({**_id_fields(team_id, agent_id, user_id, task_id),
                         "path": path, "content": content, "summary": summary}),
        )

    async def rm_scenario(
        self, path: str, *,
        team_id: Optional[str] = None, agent_id: Optional[str] = None,
        user_id: Optional[str] = None, task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/scenario/rm",
            {**_id_fields(team_id, agent_id, user_id, task_id), "path": path},
        )

    # -- L3 Core -----------------------------------------------------------

    async def read_core(
        self, *,
        team_id: Optional[str] = None, agent_id: Optional[str] = None,
        user_id: Optional[str] = None, task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /core/read`` — returns ``content: None`` if not yet generated."""
        return await self._stub.post(
            f"{_V2}/core/read",
            _id_fields(team_id, agent_id, user_id, task_id),
        )

    async def write_core(
        self, content: str, *,
        team_id: Optional[str] = None, agent_id: Optional[str] = None,
        user_id: Optional[str] = None, task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return await self._stub.post(
            f"{_V2}/core/write",
            {**_id_fields(team_id, agent_id, user_id, task_id), "content": content},
        )

    # -- Offload (Ingest + Compact + Query-MMD) ----------------------------

    async def offload_ingest(
        self,
        session_id: str,
        tool_pairs: List[Dict[str, Any]],
        *,
        prompt: Optional[str] = None,
        recent_messages: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """``POST /v2/offload/ingest`` (asynchronous)"""
        return await self._stub.post(
            f"{_V2}/offload/ingest",
            _strip_none({
                "session_id": session_id,
                "tool_pairs": tool_pairs,
                "prompt": prompt,
                "recent_messages": recent_messages,
            }),
        )

    async def offload_compact(
        self,
        session_id: str,
        messages: List[Dict[str, Any]],
        ratio: float,
        total_tokens: int,
        *,
        context_window: Optional[int] = None,
        message_tokens: Optional[List[int]] = None,
    ) -> Dict[str, Any]:
        """``POST /v2/offload/compact`` (asynchronous)"""
        return await self._stub.post(
            f"{_V2}/offload/compact",
            _strip_none({
                "session_id": session_id,
                "messages": messages,
                "ratio": ratio,
                "total_tokens": total_tokens,
                "context_window": context_window,
                "message_tokens": message_tokens,
            }),
        )

    async def offload_query_mmd(
        self,
        session_id: str,
        *,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """``POST /v2/offload/query-mmd`` (asynchronous)"""
        return await self._stub.post(
            f"{_V2}/offload/query-mmd",
            _strip_none({
                "session_id": session_id,
                "limit": limit,
            }),
        )

    # -- lifecycle ---------------------------------------------------------

    # -- File read (memory pipeline artifacts) -----------------------------

    async def read_file(self, path: str) -> str:
        """Read a memory pipeline artifact (async)."""
        if self._cos_reader is None:
            self._sts_manager = AsyncStsCredentialManager(
                endpoint=self._stub.endpoint,
                api_key=self._stub.headers["Authorization"].removeprefix("Bearer "),
                service_id=self._stub.headers["x-tdai-service-id"],
            )
            self._cos_reader = AsyncMemoryFileReader(self._sts_manager)
        return await self._cos_reader.read(path)

    # -- lifecycle ---------------------------------------------------------

    async def close(self) -> None:
        if self._cos_reader is not None:
            await self._cos_reader.close()
        await self._stub.close()

    async def __aenter__(self) -> "AsyncMemoryClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
