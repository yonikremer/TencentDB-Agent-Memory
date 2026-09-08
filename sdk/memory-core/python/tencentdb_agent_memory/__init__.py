"""TencentDB Agent Memory Python SDK.

v3 only — strict-isolation data plane (``/v3/*``). No v1/v2 client remains;
construct with the team/agent/user isolation tuple:

>>> from tencentdb_agent_memory import MemoryClient
>>> client = MemoryClient(endpoint, api_key, service_id="...",
...                       team_id="t1", agent_id="a1", user_id="u1")
>>> client.add_conversation(session_id="s1", messages=[...])
"""

from .errors import ParamError, TDAMError
from .v3 import AsyncMemoryClient, MemoryClient

__all__ = ["MemoryClient", "AsyncMemoryClient", "TDAMError", "ParamError"]
