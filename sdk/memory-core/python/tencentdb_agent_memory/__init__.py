"""TencentDB Agent Memory Python SDK.

Version Layout (referencing tencentcloud-sdk-python submodule split style):

- Default exports `MemoryClient` / `AsyncMemoryClient` point to v2 — older code can upgrade the SDK without any modification to continue working.
- Explicit import `from tencentdb_agent_memory.v3 import MemoryClient` switches to v3
  strict isolation version (team/agent/user/session are all required during construction, path uses /v3).

>>> # Old code
>>> from tencentdb_agent_memory import MemoryClient
>>> client = MemoryClient(endpoint, api_key, service_id="...")
>>> client.add_conversation(session_id="s1", messages=[...])

>>> # New code (strict isolation)
>>> from tencentdb_agent_memory.v3 import MemoryClient
>>> client = MemoryClient(endpoint, api_key, service_id="...",
...                       team_id="t1", agent_id="a1", user_id="u1")
>>> client.add_conversation(session_id="s1", messages=[...])
"""

from .errors import ParamError, TDAMError
from .v2 import AsyncMemoryClient, MemoryClient

__all__ = ["MemoryClient", "AsyncMemoryClient", "TDAMError", "ParamError"]
