"""TencentDB Agent Memory v3 Python SDK — strict isolation data plane client.

Construction requires the team_id / agent_id / user_id / session_id tuple;
Path uses ``/v3/...``. See ``v3.client.MemoryClient`` docstring for details.

The management plane client :class:`MetadataClient` / :class:`AsyncMetadataClient` does not require the isolation
tuple, and wraps the ``/v3/meta/*`` public endpoints (54 total, aligned with Panel ``META_ACTIONS``) and
``/v3/knowledge/*`` Knowledge CRUD. See ``v3.metadata_client`` for details.

The Skill client :class:`SkillClient` / :class:`AsyncSkillClient` wraps the 14
``/v3/skill/*`` endpoints — the isolation fields for skills are all optional at the server schema layer,
pass default values as needed during construction, missing values will be handled by the server returning business error codes (40001/40301/40302).
"""

from .client import AsyncMemoryClient, MemoryClient
from .metadata_client import AsyncMetadataClient, MetadataClient
from .memory_prompt import AsyncMemoryPromptClient, MemoryPromptClient
from .memory_generation_log import AsyncMemoryGenerationLogClient, MemoryGenerationLogClient
from .skill_client import (
    SKILL_ERROR_CODE,
    AsyncSkillClient,
    SkillClient,
    encode_base64,
    encode_utf8,
)

__all__ = [
    "MemoryClient",
    "AsyncMemoryClient",
    "MetadataClient",
    "AsyncMetadataClient",
    "MemoryPromptClient",
    "AsyncMemoryPromptClient",
    "MemoryGenerationLogClient",
    "AsyncMemoryGenerationLogClient",
    "SkillClient",
    "AsyncSkillClient",
    "SKILL_ERROR_CODE",
    "encode_utf8",
    "encode_base64",
]
