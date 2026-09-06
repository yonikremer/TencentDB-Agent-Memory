import pytest

from tencentdb_agent_memory.errors import ParamError
from tencentdb_agent_memory.v3.memory_prompt import AsyncMemoryPromptClient, MemoryPromptClient
from fakes import FakeAsyncPostOnly, FakeAsyncStub, FakeStub, PostOnlyStub


def _sync(**kw):
    stub = FakeStub()
    return MemoryPromptClient(endpoint="http://e", api_key="k", service_id="s", stub=stub, **kw), stub


def test_init_and_get_fallback():
    with pytest.raises(ParamError):
        MemoryPromptClient(endpoint="http://e", api_key="k")
    real = MemoryPromptClient(endpoint="http://e", api_key="k", service_id="s")
    real.close()
    c, stub = _sync(team_id="t", agent_id="a")
    c.get("mp-1")
    assert stub.calls[-1][0] == "GET"
    cp = MemoryPromptClient(endpoint="http://e", api_key="k", service_id="s", stub=PostOnlyStub())
    cp.get("mp-1")
    assert cp._stub.calls[-1][0] == "POST"
    cp.close()
    c.close()


def test_crud():
    c, stub = _sync()
    c.create(name="n", layer="l1", prompt="p")
    assert stub.calls[-1][1] == "/v3/memory-prompt/create"
    with pytest.raises(ParamError):
        c.create(name="  ", layer="l1", prompt="p")
    with pytest.raises(ParamError):
        c.create(name="n", layer="l1", prompt="")
    c.list(layer="l1", limit=5, offset=0, time_order="asc")
    assert stub.calls[-1][1] == "/v3/memory-prompt/get"
    c.update("mp-1", name="n2")
    c.update("mp-1", prompt="p2")
    with pytest.raises(ParamError):
        c.update("mp-1")
    with pytest.raises(ParamError):
        c.update("  ", name="n")
    with pytest.raises(ParamError):
        c.get("")
    c.delete(["a", "b"])
    assert stub.calls[-1][1] == "/v3/memory-prompt/delete"
    for bad in ("str-not-list", [], ["ok", ""], ["ok", 5], (x for x in ["a"])):
        with pytest.raises(ParamError):
            c.delete(bad)
    c.close()


def test_effective_and_targets():
    c, stub = _sync(team_id="t", agent_id="a")
    c.get_effective(layer="l1")
    assert stub.calls[-1][2]["team_id"] == "t"
    c.get_effective(layer="l1", team_id="t2", agent_id="a2")
    assert stub.calls[-1][2]["team_id"] == "t2"
    bare, _ = _sync()
    with pytest.raises(ParamError):
        bare.get_effective(layer="l1")
    c.apply("mp-1", layer="l1")
    assert stub.calls[-1][2]["action"] == "apply"
    c.apply("mp-1", layer="l1", team_id="t", agent_ids=["a1"])
    bare2, _ = _sync()
    with pytest.raises(ParamError):
        bare2.apply("mp-1", layer="l1", agent_ids=["a1"])
    with pytest.raises(ParamError):
        c.apply("mp-1", layer="l1", team_id="t", agent_ids=[])
    with pytest.raises(ParamError):
        c.apply("", layer="l1")
    c.clear(layer="l1", team_id="t", agent_ids=["a1"])
    assert stub.calls[-1][2]["action"] == "clear"
    with pytest.raises(ParamError):
        bare2.clear(layer="l1", agent_ids=["a1"])
    c.close()


def test_settings_and_logs():
    c, stub = _sync(team_id="t", agent_id="a")
    c.list_settings(memory_prompt_id="mp")
    c.list_settings(target_type="agent")
    nodefaults, _ = _sync()
    nodefaults.list_settings(target_type="team", team_id="t")
    with pytest.raises(ParamError):
        c.list_settings(target_type="instance", team_id="t")
    with pytest.raises(ParamError):
        c.list_settings(target_type="instance", agent_id="a", team_id="t")
    with pytest.raises(ParamError):
        c.list_settings(target_type="team", team_id="t", agent_id="a")
    with pytest.raises(ParamError):
        MemoryPromptClient(endpoint="http://e", api_key="k", service_id="s",
                           stub=FakeStub(), agent_id="a").list_settings()
    c.list_setting_logs(memory_prompt_id="mp")
    c.list_setting_logs(team_id="t", action="apply", limit=5, offset=1, time_order="asc",
                        start_time="2026-01-01T00:00:00Z", end_time="2026-01-02T00:00:00Z")
    with pytest.raises(ParamError):
        MemoryPromptClient(endpoint="http://e", api_key="k", service_id="s",
                           stub=FakeStub()).list_setting_logs()
    with pytest.raises(ParamError):
        MemoryPromptClient(endpoint="http://e", api_key="k", service_id="s",
                           stub=FakeStub(), agent_id="a").list_setting_logs(memory_prompt_id="m")
    c.close()


@pytest.mark.asyncio
async def test_async_mirror():
    with pytest.raises(ParamError):
        AsyncMemoryPromptClient(endpoint="http://e", api_key="k")
    c = AsyncMemoryPromptClient(endpoint="http://e", api_key="k", service_id="s",
                                stub=FakeAsyncStub(), team_id="t", agent_id="a")
    stub = c._stub
    await c.create(name="n", layer="l1", prompt="p")
    with pytest.raises(ParamError):
        await c.create(name="", layer="l1", prompt="p")
    await c.get("mp")
    await c.list(layer="l1")
    await c.get_effective(layer="l1")
    with pytest.raises(ParamError):
        await AsyncMemoryPromptClient(endpoint="http://e", api_key="k", service_id="s",
                                      stub=FakeAsyncStub()).get_effective(layer="l1")
    await c.update("mp", name="n")
    with pytest.raises(ParamError):
        await c.update("mp")
    await c.delete(["a"])
    await c.apply("mp", layer="l1")
    bare = AsyncMemoryPromptClient(endpoint="http://e", api_key="k", service_id="s", stub=FakeAsyncStub())
    with pytest.raises(ParamError):
        await bare.apply("mp", layer="l1", agent_ids=["a"])
    await bare.close()
    await c.clear(layer="l1")
    await c.list_settings(memory_prompt_id="m")
    with pytest.raises(ParamError):
        await c.list_settings(target_type="instance", team_id="t")
    with pytest.raises(ParamError):
        await c.list_settings(target_type="team", team_id="t", agent_id="a")
    await c.list_setting_logs(memory_prompt_id="m")
    with pytest.raises(ParamError):
        await bare.list_setting_logs()
    cp = AsyncMemoryPromptClient(endpoint="http://e", api_key="k", service_id="s", stub=FakeAsyncPostOnly())
    await cp.get("mp-1")
    assert cp._stub.calls[-1][0] == "POST"
    await cp.close()
    await c.close()
