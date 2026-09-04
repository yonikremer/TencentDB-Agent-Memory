"""TencentDB Agent Memory v2 Python SDK (Current data plane + management plane API, uses /v2 path).

Explicit v2 entrypoint; top-level `from tencentdb_agent_memory import MemoryClient` still points here,
so older code can upgrade the SDK without any modification to continue working.
"""

from .client import AsyncMemoryClient, MemoryClient

__all__ = ["MemoryClient", "AsyncMemoryClient"]
