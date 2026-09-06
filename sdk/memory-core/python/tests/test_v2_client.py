import pytest

import tencentdb_agent_memory.v2.client as v2mod
from tencentdb_agent_memory.v2 import AsyncMemoryClient, MemoryClient
from tencentdb_agent_memory.v2.client import _id_fields, _strip_none

from fakes import FakeAsyncReader, FakeAsyncStub, FakeReader, FakeStub, FakeStsMgr


def test_helpers():
    assert _strip_none({"a": 1, "b": None}) == {"a": 1}
    assert _id_fields("t", None, "u", None) == {"team_id": "t", "user_id": "u"}


def test_init_variants():
    c = MemoryClient(stub=FakeStub())
    assert isinstance(c, MemoryClient)
    with pytest.raises(ValueError):
        MemoryClient(endpoint="http://e", api_key="k")
    real = MemoryClient(endpoint="http://e", api_key="k", service_id="s")
    real.close()
    with MemoryClient(stub=FakeStub()) as ctx:
        assert ctx is not None


def _sync():
    stub = FakeStub()
    return MemoryClient(stub=stub), stub


def test_l0():
    c, stub = _sync()
    c.add_conversation("s1", [{"role": "user", "content": "hi"}], team_id="t")
    assert stub.calls[-1] == ("POST", "/v2/conversation/add",
                              {"team_id": "t", "session_id": "s1",
                               "messages": [{"role": "user", "content": "hi"}]})
    c.query_conversation(session_id="s", limit=5, offset=None)
    assert stub.calls[-1][1] == "/v2/conversation/query"
    assert stub.calls[-1][2] == {"session_id": "s", "limit": 5}
    c.search_conversation("q", limit=2)
    assert stub.calls[-1][1] == "/v2/conversation/search"
    c.delete_conversation(message_ids=["m1"])
    assert stub.calls[-1][1] == "/v2/conversation/delete"
    c.close()
    assert stub.closed


def test_l1():
    c, stub = _sync()
    c.update_atomic("id1", "c", background="b")
    assert stub.calls[-1][2]["background"] == "b"
    c.query_atomic(type="t", limit=1)
    assert stub.calls[-1][1] == "/v2/atomic/query"
    c.search_atomic("q", type="t")
    assert stub.calls[-1][1] == "/v2/atomic/search"
    c.delete_atomic(["a", "b"])
    assert stub.calls[-1][2] == {"ids": ["a", "b"]}
    c.close()


def test_l2_l3():
    c, stub = _sync()
    c.list_scenarios(path_prefix="p")
    assert stub.calls[-1][1] == "/v2/scenario/ls"
    c.read_scenario("notes/a.md")
    assert stub.calls[-1][2]["path"] == "notes/a.md"
    c.write_scenario("p", "c", summary="s")
    assert stub.calls[-1][2]["summary"] == "s"
    c.rm_scenario("p")
    assert stub.calls[-1][1] == "/v2/scenario/rm"
    c.read_core(team_id="t")
    assert stub.calls[-1][1] == "/v2/core/read"
    c.write_core("core-content")
    assert stub.calls[-1][2]["content"] == "core-content"
    c.close()


def test_offload():
    c, stub = _sync()
    c.offload_ingest("s", [{"tool_name": "t"}], prompt="p", recent_messages=[{"role": "user"}])
    assert stub.calls[-1][1] == "/v2/offload/ingest"
    c.offload_compact("s", [{"m": 1}], 0.9, 100, context_window=1000, message_tokens=[10])
    assert stub.calls[-1][1] == "/v2/offload/compact"
    c.offload_query_mmd("s", limit=1)
    assert stub.calls[-1][2] == {"session_id": "s", "limit": 1}
    c.offload_query_mmd("s")
    assert stub.calls[-1][2] == {"session_id": "s"}
    c.close()


def test_read_file_lazy_and_cached(monkeypatch):
    monkeypatch.setattr(v2mod, "StsCredentialManager", FakeStsMgr)
    monkeypatch.setattr(v2mod, "MemoryFileReader", FakeReader)
    c, stub = _sync()
    assert c.read_file("persona.md") == "content:persona.md"
    first = c._cos_reader
    assert c.read_file("a.md") == "content:a.md"
    assert c._cos_reader is first
    assert c._sts_manager.kwargs["service_id"] == "s"
    c.close()
    assert first.closed and stub.closed


@pytest.mark.asyncio
async def test_async_full_surface(monkeypatch):
    monkeypatch.setattr(v2mod, "AsyncStsCredentialManager", FakeStsMgr)
    monkeypatch.setattr(v2mod, "AsyncMemoryFileReader", FakeAsyncReader)
    with pytest.raises(ValueError):
        AsyncMemoryClient(endpoint="http://e", api_key="k")
    c = AsyncMemoryClient(endpoint="http://e", api_key="k", service_id="s")
    stub = FakeAsyncStub()
    c._stub = stub
    await c.add_conversation("s", [])
    await c.query_conversation(limit=1)
    await c.search_conversation("q")
    await c.delete_conversation(session_id="s")
    await c.update_atomic("i", "c")
    await c.query_atomic()
    await c.search_atomic("q")
    await c.delete_atomic(["x"])
    await c.list_scenarios()
    await c.read_scenario("p")
    await c.write_scenario("p", "c")
    await c.rm_scenario("p")
    await c.read_core()
    await c.write_core("cc")
    await c.offload_ingest("s", [])
    await c.offload_compact("s", [], 0.5, 10)
    await c.offload_query_mmd("s")
    paths = [call[1] for call in stub.calls]
    assert paths == [
        "/v2/conversation/add", "/v2/conversation/query", "/v2/conversation/search",
        "/v2/conversation/delete", "/v2/atomic/update", "/v2/atomic/query",
        "/v2/atomic/search", "/v2/atomic/delete", "/v2/scenario/ls",
        "/v2/scenario/read", "/v2/scenario/write", "/v2/scenario/rm",
        "/v2/core/read", "/v2/core/write", "/v2/offload/ingest",
        "/v2/offload/compact", "/v2/offload/query-mmd",
    ]
    assert await c.read_file("persona.md") == "content:persona.md"
    async with c:
        pass
    assert stub.closed
