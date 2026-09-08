"""Shared transport base for the TencentDB Agent Memory Python SDK.

Concrete transports live in :mod:`tencentdb_agent_memory._v3_http`.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

# ---------------------------------------------------------------------------
# Stub abstraction
# ---------------------------------------------------------------------------

class Stub(ABC):
    """Base transport interface."""

    endpoint: str
    headers: dict[str, str]

    @abstractmethod
    def post(self, path: str, body: dict, timeout: float | None = None) -> dict:
        ...

    @abstractmethod
    def close(self) -> None:
        ...
