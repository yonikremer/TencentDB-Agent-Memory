import pytest

import tencentdb_agent_memory.v3.client as v3mod
from tencentdb_agent_memory.errors import ParamError
from tencentdb_agent_memory.v3.client import (
    AsyncMemoryClient,
    MemoryClient,
    _IsolationCtx,
    _normalize_delete_ids,
    _strip_none,
    _validate_construction,
)
from fakes import FakeAsyncStub, FakeStub

KW = dict(team_id="t1", agent_id="a1", user_id="u1")


def _sync(**kw):
    args = dict(KW)
    args.update(kw)
    stub = FakeStub()
    return MemoryClient(endpoint="http://e", api_key="k", service_id="s", stub=stub, **args), stub


def test_helpers_and_validation():
    assert _strip_none({"a": 1, "b": None}) == {"a": 1}
    assert _normalize_delete_ids("f", None, 5) is None
    assert _normalize_delete_ids("f", [" a ", "a", "b"], 5) == ["a", "b"]
    assert _normalize_delete_ids("f", ("x",), 5) == ["x"]
    for bad in ("nope", ["ok", ""], ["ok", 1], ["  "], None.__class__):
        with pytest.raises(ParamError):
            _normalize_delete_ids("f", bad, 5)
    with pytest.raises(ParamError):
        _normalize_delete_ids("f", [f"m{i}" for i in range(6)], 5)
    for missing in (dict(team_id="", agent_id="a", user_id="u"),
                    dict(team_id="t", agent_id="", user_id="u"),
                    dict(team_id="t", agent_id="a", user_id="")):
        with pytest.raises(ParamError):
            _validate_construction(**missing)
    _validate_construction("t", "a", "u")


def test_isolation_ctx():
    iso = _IsolationCtx("t", "a", "u", "s", "tk")
    assert iso.base_body() == {"team_id": "t", "agent_id": "a", "user_id": "u", "task_id": "tk"}
    assert _IsolationCtx("t", "a", "u").base_body() == {"team_id": "t", "agent_id": "a", "user_id": "u"}
    assert iso.resolve_session(None) == "s"
    assert iso.resolve_session("s2") == "s2"
    assert iso.resolve_session_for_write(None) == "s"
    with pytest.raises(ParamError):
        _IsolationCtx("t", "a", "u").resolve_session_for_write(None)


def test_init_variants():
    with pytest.raises(ParamError):
        MemoryClient(endpoint="http://e", api_key="k", service_id="s", team_id="", agent_id="a", user_id="u")
    with pytest.raises(ParamError):
        MemoryClient(endpoint="http://e", api_key="k", team_id="t", agent_id="a", user_id="u")
    real = MemoryClient(endpoint="http://e", api_key="k", service_id="s", **KW)
    real.close()
    with MemoryClient(endpoint="http://e", api_key="k", service_id="s", stub=FakeStub(), **KW) as c:
        assert isinstance(c, MemoryClient)


def test_with_isolation():
    c, stub = _sync(session_id="s1", task_id="tk1")
    c2 = c.with_isolation(team_id="t2")
    c2.query_conversation(limit=1)
    assert stub.calls[-1][2]["team_id"] == "t2"
    assert stub.calls[-1][2]["session_id"] == "s1"
    c3 = c.with_isolation(session_id=None, task_id=None)
    c3.query_conversation()
    assert "session_id" not in stub.calls[-1][2]
    assert "task_id" not in stub.calls[-1][2]
    with pytest.raises(ParamError):
        c.with_isolation(team_id="")
    assert v3mod._UNSET is not None


def test_add_conversation_session_rules():
    c, stub = _sync(session_id="s1")
    c.add_conversation([{"role": "user", "content": "hi"}])
    assert stub.calls[-1][2]["session_id"] == "s1"
    c.add_conversation([{"m": 1}], session_id="s9")
    assert stub.calls[-1][2]["session_id"] == "s9"
    c2, _ = _sync()
    with pytest.raises(ParamError):
        c2.add_conversation([{"m": 1}])
    c.close()


def test_l0_read_paths():
    c, stub = _sync(session_id="s1")
    c.query_conversation(limit=2, offset=1, time_start="a", time_end="b")
    assert stub.calls[-1][1] == "/v3/conversation/query"
    c.search_conversation("q", limit=3, session_id="s2", time_start="a", time_end="b")
    assert stub.calls[-1][2]["query"] == "q"
    c.count_conversation(time_start="a", time_end="b")
    assert stub.calls[-1][1] == "/v3/conversation/count"
    c.close()


def test_delete_conversation():
    c, stub = _sync()
    c.delete_conversation(message_ids=["m1", "m1 "])
    assert stub.calls[-1][2] == {**KW, "message_ids": ["m1"]}
    c.delete_conversation(session_ids=["s1"], session_id="s1")
    assert stub.calls[-1][2]["session_ids"] == ["s1"]
    c.delete_conversation(session_id="legacy")
    assert stub.calls[-1][2]["session_ids"] == ["legacy"]
    with pytest.raises(ParamError):
        c.delete_conversation()
    with pytest.raises(ParamError):
        c.delete_conversation(session_id="")
    with pytest.raises(ParamError):
        c.delete_conversation(session_id=123)
    c.close()


def test_l1():
    c, stub = _sync()
    c.update_atomic("i", "content", background="b", session_id="s")
    assert stub.calls[-1][1] == "/v3/atomic/update"
    c.query_atomic(type="t", limit=1, offset=0, time_start="a", time_end="b", session_id="s")
    assert stub.calls[-1][1] == "/v3/atomic/query"
    c.search_atomic("q", limit=1, type="t", time_start="a", time_end="b")
    assert stub.calls[-1][1] == "/v3/atomic/search"
    c.delete_atomic(["x", "x"], session_id="s")
    assert stub.calls[-1][2]["ids"] == ["x"]
    with pytest.raises(ParamError):
        c.delete_atomic([])
    c.count_atomic(type="t", time_start="a", time_end="b")
    assert stub.calls[-1][1] == "/v3/atomic/count"
    c.close()


def test_l2_l3_and_clear():
    c, stub = _sync()
    c.list_scenarios(path_prefix="p")
    c.read_scenario("a/b.md")
    c.write_scenario("a", "c", summary="s")
    c.rm_scenario("a")
    c.count_scenario(path_prefix="p")
    c.read_core()
    c.write_core("core")
    c.count_core()
    paths = [call[1] for call in stub.calls]
    assert paths == ["/v3/scenario/ls", "/v3/scenario/read", "/v3/scenario/write",
                     "/v3/scenario/rm", "/v3/scenario/count", "/v3/core/read",
                     "/v3/core/write", "/v3/core/count"]
    c.clear_chat_memory(["m1", "m1"])
    assert stub.calls[-1] == ("POST", "/v3/chat-memory/clear", {"memory_ids": ["m1"]})
    with pytest.raises(ParamError):
        c.clear_chat_memory([])
    with pytest.raises(ParamError):
        c.clear_chat_memory("nope")
    c.close()


@pytest.mark.asyncio
async def test_async_mirror():
    with pytest.raises(ParamError):
        AsyncMemoryClient(endpoint="http://e", api_key="k", service_id="s",
                          team_id="t", agent_id="", user_id="u")
    with pytest.raises(ParamError):
        AsyncMemoryClient(endpoint="http://e", api_key="k", team_id="t", agent_id="a", user_id="u")
    c = AsyncMemoryClient(endpoint="http://e", api_key="k", service_id="s", stub=FakeAsyncStub(), **KW)
    stub = c._stub
    c2 = c.with_isolation(session_id=None)
    await c2.query_conversation()
    assert "session_id" not in stub.calls[-1][2]
    with pytest.raises(ParamError):
        c.with_isolation(user_id="")
    with pytest.raises(ParamError):
        await AsyncMemoryClient(endpoint="http://e", api_key="k", service_id="s",
                                stub=FakeAsyncStub(), **KW).add_conversation([{"m": 1}])
    await c.add_conversation([{"m": 1}], session_id="s1")
    await c.query_conversation()
    await c.search_conversation("q")
    await c.delete_conversation(message_ids=["m"])
    await c.delete_conversation(session_id="s-leg")
    assert stub.calls[-1][2]["session_ids"] == ["s-leg"]
    await c.delete_conversation(message_ids=["m"], session_ids=["s1"], session_id="s1")
    assert stub.calls[-1][2]["session_ids"] == ["s1"]
    with pytest.raises(ParamError):
        await c.delete_conversation(session_id="")
    with pytest.raises(ParamError):
        await c.delete_conversation()
    await c.count_conversation()
    await c.update_atomic("i", "c")
    await c.query_atomic()
    await c.search_atomic("q")
    await c.delete_atomic(["x"])
    with pytest.raises(ParamError):
        await c.delete_atomic([])
    await c.count_atomic()
    await c.list_scenarios()
    await c.read_scenario("p")
    await c.write_scenario("p", "c")
    await c.rm_scenario("p")
    await c.count_scenario()
    await c.read_core()
    await c.write_core("c")
    await c.count_core()
    await c.clear_chat_memory(["m1"])
    with pytest.raises(ParamError):
        await c.clear_chat_memory([])
    async with c:
        pass
    assert stub.closed
