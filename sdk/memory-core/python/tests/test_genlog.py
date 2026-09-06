import pytest

from tencentdb_agent_memory.errors import ParamError
from tencentdb_agent_memory.v3.memory_generation_log import (
    AsyncMemoryGenerationLogClient,
    MemoryGenerationLogClient,
)
from fakes import FakeAsyncPostOnly, FakeAsyncStub, FakeStub, PostOnlyStub


def _sync():
    stub = FakeStub()
    return MemoryGenerationLogClient(endpoint="http://e", api_key="k", service_id="s", stub=stub), stub


def test_init_and_list():
    with pytest.raises(ParamError):
        MemoryGenerationLogClient(endpoint="http://e", api_key="k")
    real = MemoryGenerationLogClient(endpoint="http://e", api_key="k", service_id="s")
    real.close()
    c, stub = _sync()
    c.list(layer="l1", status="succeeded", start_time="a", end_time="b", limit=5, cursor="c")
    assert stub.calls[-1] == ("GET", "/v3/memory-generation-log/list",
                              {"layer": "l1", "status": "succeeded", "start_time": "a",
                               "end_time": "b", "limit": 5, "cursor": "c"})
    c.list()
    assert stub.calls[-1][2] == {}
    c.close()


def test_get_branches():
    c, stub = _sync()
    c.get("log-1")
    assert stub.calls[-1][2] == {"log_id": "log-1"}
    c.get(memory_id="m1", layer="l2")
    assert stub.calls[-1][2] == {"memory_id": "m1", "layer": "l2"}
    c.get_by_memory_id("m2", "l3")
    assert stub.calls[-1][2] == {"memory_id": "m2", "layer": "l3"}
    with pytest.raises(ParamError):
        c.get("")
    with pytest.raises(ParamError):
        c.get()
    with pytest.raises(ParamError):
        c.get("log-1", memory_id="m1")
    with pytest.raises(ParamError):
        c.get(memory_id="m1")
    with pytest.raises(ParamError):
        c.get(memory_id="", layer="l1")
    with pytest.raises(ParamError):
        c.get_by_memory_id("m1", "")
    c.close()


def test_get_fallback_to_post():
    c = MemoryGenerationLogClient(endpoint="http://e", api_key="k", service_id="s", stub=PostOnlyStub())
    c.get("log-1")
    assert c._stub.calls[-1][0] == "POST"
    c.close()


@pytest.mark.asyncio
async def test_async_mirror():
    with pytest.raises(ParamError):
        AsyncMemoryGenerationLogClient(endpoint="http://e", api_key="k")
    c = AsyncMemoryGenerationLogClient(endpoint="http://e", api_key="k", service_id="s",
                                       stub=FakeAsyncStub())
    await c.list(layer="l1")
    await c.get("log-1")
    await c.get(memory_id="m1", layer="l1")
    await c.get_by_memory_id("m", "l1")
    with pytest.raises(ParamError):
        await c.get()
    with pytest.raises(ParamError):
        await c.get("a", memory_id="b")
    with pytest.raises(ParamError):
        await c.get(memory_id="m")
    await c.close()
    cp = AsyncMemoryGenerationLogClient(endpoint="http://e", api_key="k", service_id="s",
                                        stub=FakeAsyncPostOnly())
    await cp.list()
    assert cp._stub.calls[-1][0] == "POST"
    await cp.close()
