"""TencentDB Agent Memory v3 Ops SDK — Knowledge Service ops plane (shared ``HttpStub``).

- LLM binding (``POST /v3/internal/llm-binding/{set,status,list}``):
  per-instance LLM routing; ``api_key`` is never echoed back; ``list``
  needs no service-id. First set for an instance requires ``api_key``
  server-side — omit it only when updating an already-bound instance.
- Auto-sync (``GET /v3/auto-sync/status``, ``POST /v3/auto-sync/trigger``):
  scheduler snapshot + manual fire-and-forget scan trigger.

Auth: ``x-tdai-service-id`` always sent; ``Authorization: Bearer`` only
when ``api_key`` is given (KS default needs none).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .._v3_http import AsyncHttpStub, HttpStub
from ..errors import ParamError
from ._common import ks_stub, need, strip_none

_V3BIND = "/v3/internal/llm-binding"
_V3SYNC = "/v3/auto-sync"


def _check_set(p: Dict[str, Any]) -> None:
    mode = p.get("mode")
    if mode not in ("proxy", "byo"):
        raise ParamError("llm_binding_set mode must be 'proxy' or 'byo'")
    if mode == "proxy" and not p.get("proxy_base_url"):
        raise ParamError("llm_binding_set proxy mode requires proxy_base_url")
    if mode == "byo" and not p.get("base_url"):
        raise ParamError("llm_binding_set byo mode requires base_url")


class _OpsMethodsMixin:
    _stub: Any

    def _llm_binding_set(self, p: Dict[str, Any]) -> Dict[str, Any]:
        _check_set(p)
        return self._stub.post(f"{_V3BIND}/set", strip_none({
            "mode": p.get("mode"), "api_key": p.get("api_key"),
            "proxy_base_url": p.get("proxy_base_url"), "base_url": p.get("base_url"),
            "enabled": p.get("enabled"),
        }))

    def _llm_binding_status(self) -> Dict[str, Any]:
        return self._stub.post(f"{_V3BIND}/status", {})

    def _llm_binding_list(self) -> Dict[str, Any]:
        return self._stub.post(f"{_V3BIND}/list", {})

    def _auto_sync_status(self) -> Dict[str, Any]:
        return self._stub.get(f"{_V3SYNC}/status")

    def _auto_sync_trigger(self) -> Dict[str, Any]:
        return self._stub.post(f"{_V3SYNC}/trigger", {})


class OpsClient(_OpsMethodsMixin):
    """Sync KS ops client (llm-binding + auto-sync)."""

    def __init__(self, endpoint: str = "", service_id: Optional[str] = None, *, api_key: str = "", timeout: float = 30, verify: bool = True, stub: Optional[Any] = None) -> None:
        self._stub = stub if stub is not None else ks_stub(endpoint, service_id, api_key=api_key, timeout=timeout, verify=verify)

    def llm_binding_set(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return self._llm_binding_set(p)

    def llm_binding_status(self) -> Dict[str, Any]:
        return self._llm_binding_status()

    def llm_binding_list(self) -> Dict[str, Any]:
        return self._llm_binding_list()

    def auto_sync_status(self) -> Dict[str, Any]:
        return self._auto_sync_status()

    def auto_sync_trigger(self) -> Dict[str, Any]:
        return self._auto_sync_trigger()

    def close(self) -> None:
        c = getattr(self._stub, "close", None)
        if callable(c):
            c()

    def __enter__(self) -> "OpsClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class AsyncOpsClient(_OpsMethodsMixin):
    """Async KS ops client — same surface as OpsClient."""

    def __init__(self, endpoint: str = "", service_id: Optional[str] = None, *, api_key: str = "", timeout: float = 30, verify: bool = True, stub: Optional[Any] = None) -> None:
        self._stub = stub if stub is not None else ks_stub(endpoint, service_id, api_key=api_key, timeout=timeout, verify=verify, async_=True)

    async def llm_binding_set(self, p: Dict[str, Any]) -> Dict[str, Any]:
        return await self._llm_binding_set(p)

    async def llm_binding_status(self) -> Dict[str, Any]:
        return await self._llm_binding_status()

    async def llm_binding_list(self) -> Dict[str, Any]:
        return await self._llm_binding_list()

    async def auto_sync_status(self) -> Dict[str, Any]:
        return await self._auto_sync_status()

    async def auto_sync_trigger(self) -> Dict[str, Any]:
        return await self._auto_sync_trigger()
