"""Shared transport base for the TencentDB Agent Memory Python SDK.

Concrete transports live in :mod:`tencentdb_agent_memory._v3_http`.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

# ---------------------------------------------------------------------------
# Stub abstraction
# ---------------------------------------------------------------------------


class Stub(ABC):
    """Base transport interface."""

    endpoint: str
    headers: dict[str, str]

    @abstractmethod
    def post(self, path: str, body: dict, timeout: float | None = None) -> Any: ...

    @abstractmethod
    def close(self) -> None: ...


class AsyncStub(ABC):
    """Async transport interface (awaitable post/get)."""

    endpoint: str
    headers: dict[str, str]

    @abstractmethod
    async def post(
        self, path: str, body: dict, timeout: float | None = None
    ) -> dict: ...

    @abstractmethod
    async def get(
        self, path: str, query: dict | None = None, timeout: float | None = None
    ) -> dict: ...

    @abstractmethod
    async def close(self) -> None: ...
