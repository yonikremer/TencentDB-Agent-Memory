import tencentdb_agent_memory as top
import tencentdb_agent_memory.v2 as v2mod
import tencentdb_agent_memory.v3 as v3mod
from tencentdb_agent_memory.v2.client import AsyncMemoryClient as V2Async
from tencentdb_agent_memory.v2.client import MemoryClient as V2Sync
from tencentdb_agent_memory.v3.client import AsyncMemoryClient as V3Async
from tencentdb_agent_memory.v3.client import MemoryClient as V3Sync


def test_top_level_is_v2():
    assert top.MemoryClient is V2Sync
    assert top.AsyncMemoryClient is V2Async
    assert set(top.__all__) == {"MemoryClient", "AsyncMemoryClient", "TDAMError", "ParamError"}
    assert set(v2mod.__all__) == {"MemoryClient", "AsyncMemoryClient"}


def test_v3_exports():
    assert v3mod.MemoryClient is V3Sync
    assert v3mod.AsyncMemoryClient is V3Async
    for name in ("MetadataClient", "AsyncMetadataClient", "MemoryPromptClient",
                 "AsyncMemoryPromptClient", "MemoryGenerationLogClient",
                 "AsyncMemoryGenerationLogClient", "SkillClient", "AsyncSkillClient",
                 "SKILL_ERROR_CODE", "encode_utf8", "encode_base64"):
        assert name in v3mod.__all__, name
        assert getattr(v3mod, name) is not None
