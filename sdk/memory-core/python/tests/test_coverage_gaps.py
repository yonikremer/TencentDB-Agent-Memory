import httpx
import pytest

import tencentdb_agent_memory.cos as cosmod
from tencentdb_agent_memory.cos import AsyncStsCredentialManager, StsCredentialManager
from tencentdb_agent_memory.errors import ParamError
from tencentdb_agent_memory.v3 import (
    AsyncMemoryGenerationLogClient,
    AsyncMemoryPromptClient,
    AsyncMetadataClient,
    AsyncSkillClient,
)
from tencentdb_agent_memory.v3.client import AsyncMemoryClient
from tencentdb_agent_memory.v3.memory_prompt import AsyncMemoryPromptClient as APrompt
from fakes import FakeAsyncStub
from test_cos import sts_data


def test_sync_manager_creates_own_client(monkeypatch):
    mgr = StsCredentialManager("http://e", "k", "s")
    assert mgr._client is None
    real = httpx.Client
    made = {}

    def factory(*a, **k):
        made["yes"] = True
        return real(transport=httpx.MockTransport(lambda req: httpx.Response(200, json=sts_data())))

    monkeypatch.setattr(cosmod.httpx, "Client", factory)
    try:
        cred = mgr.get_credential()
        assert made["yes"] and cred.bucket == "mybucket"
    finally:
        monkeypatch.setattr(cosmod.httpx, "Client", real)
    mgr.close()


@pytest.mark.asyncio
async def test_async_manager_creates_own_client(monkeypatch):
    mgr = AsyncStsCredentialManager("http://e", "k", "s")
    assert mgr._client is None
    real = httpx.AsyncClient
    made = {}

    class _C:
        async def post(self, *a, **k):
            made["yes"] = True

            class _R:
                def raise_for_status(self):
                    pass

                def json(self):
                    return sts_data()

            return _R()

        async def aclose(self):
            pass

    monkeypatch.setattr(cosmod.httpx, "AsyncClient", lambda *a, **k: _C())
    try:
        cred = await mgr.get_credential()
        assert made["yes"] and cred.bucket == "mybucket"
    finally:
        monkeypatch.setattr(cosmod.httpx, "AsyncClient", real)
    await mgr.close()


@pytest.mark.asyncio
async def test_async_real_constructions_and_api_key_check():
    c = AsyncMemoryClient(endpoint="http://e", api_key="k", service_id="s",
                          team_id="t", agent_id="a", user_id="u", user_key="uk")
    await c.close()
    g = AsyncMemoryGenerationLogClient(endpoint="http://e", api_key="k", service_id="s")
    await g.close()
    p = AsyncMemoryPromptClient(endpoint="http://e", api_key="k", service_id="s")
    await p.close()
    s = AsyncSkillClient(endpoint="http://e", api_key="k", service_id="s")
    await s.close()
    m = AsyncMetadataClient(endpoint="http://e", api_key="k", service_id="s")
    await m.close()
    with pytest.raises(ParamError):
        AsyncMetadataClient(endpoint="http://e", api_key="", service_id="s")


@pytest.mark.asyncio
async def test_async_prompt_agent_without_team():
    bare = APrompt(endpoint="http://e", api_key="k", service_id="s",
                   stub=FakeAsyncStub(), agent_id="a")
    with pytest.raises(ParamError):
        await bare.list_settings()
    with pytest.raises(ParamError):
        await bare.list_setting_logs(memory_prompt_id="m")
    await bare.close()
