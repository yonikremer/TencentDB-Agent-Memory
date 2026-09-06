import pytest

from tencentdb_agent_memory.errors import ParamError
from tencentdb_agent_memory.v3.skill_client import (
    SKILL_ERROR_CODE,
    AsyncSkillClient,
    SkillClient,
    _SkillDefaults,
    _validate_conversation_add,
    _validate_extract,
    _validate_force_archive,
    encode_base64,
    encode_utf8,
)
from fakes import FakeAsyncStub, FakeStub

IDS = dict(team_id="t", agent_id="a", user_id="u")


def _sync(**defaults):
    stub = FakeStub()
    return SkillClient(endpoint="http://e", api_key="k", service_id="s", stub=stub, **defaults), stub


def test_module_helpers():
    assert SKILL_ERROR_CODE["NOT_FOUND"] == 40401
    assert SKILL_ERROR_CODE["VERSION_STALE"] == 40901
    assert encode_utf8("SKILL.md", "# hi") == {"path": "SKILL.md", "content": "# hi", "encoding": "utf-8"}
    assert encode_utf8("r.py", "x", mime_type="text/x-python", is_executable=True)["mime_type"] == "text/x-python"
    assert encode_base64("f.bin", "aGVsbG8=")["content"] == "aGVsbG8="
    assert encode_base64("f.bin", b"\x01\x02\x03")["content"] == "AQID"
    assert encode_base64("f.bin", bytearray(b"\x01"))["content"] == "AQ=="
    assert encode_base64("f.bin", memoryview(b"hi"), mime_type="m")["encoding"] == "base64"
    d = _SkillDefaults("t", "a", "u", "tk")
    assert d.merge(None, None, None, None) == {"team_id": "t", "agent_id": "a", "user_id": "u", "task_id": "tk"}
    assert d.merge(team_id="t2")["team_id"] == "t2"
    assert SkillClient.encode_utf8("a", "b")["encoding"] == "utf-8"
    assert SkillClient.encode_base64("a", "eA==")["encoding"] == "base64"


def test_validators():
    with pytest.raises(ParamError):
        _validate_extract([], {**IDS})
    with pytest.raises(ParamError):
        _validate_extract("nope", {**IDS})
    with pytest.raises(ParamError):
        _validate_extract([{"m": 1}], {"team_id": "t", "agent_id": "", "user_id": "u"})
    _validate_extract([{"m": 1}], {**IDS})
    with pytest.raises(ParamError):
        _validate_force_archive({"session_id": "s", "space_id": "sp", "user_id": "u", "team_id": "t"})
    _validate_force_archive({"session_id": "s", "space_id": "sp", "user_id": "u", "team_id": "t", "agent_id": "a"})
    with pytest.raises(ParamError):
        _validate_conversation_add([], {**IDS, "session_id": "s"})
    with pytest.raises(ParamError):
        _validate_conversation_add("x", {**IDS, "session_id": "s"})
    with pytest.raises(ParamError):
        _validate_conversation_add([{"m": 1}], {"team_id": "t", "agent_id": "a"})
    _validate_conversation_add([{"m": 1}], {**IDS, "session_id": "s"})


def test_init_and_defaults():
    with pytest.raises(ParamError):
        SkillClient(endpoint="http://e", api_key="k")
    real = SkillClient(endpoint="http://e", api_key="k", service_id="s")
    real.close()
    c, stub = _sync(**IDS)
    c2 = c.with_defaults(team_id="t2")
    c2.list()
    assert stub.calls[-1][2]["team_id"] == "t2"
    assert stub.calls[-1][2]["agent_id"] == "a"
    with SkillClient(endpoint="http://e", api_key="k", service_id="s", stub=FakeStub()) as ctx:
        assert ctx is not None


def test_crud_and_files():
    c, stub = _sync(**IDS)
    c.create(name="n", content="c", resources=[{"p": 1}], metadata={"k": "v"})
    assert stub.calls[-1][1] == "/v3/skill/create"
    assert stub.calls[-1][2]["team_id"] == "t"
    c.update("sk-1", expected_version=2, content="v2")
    assert stub.calls[-1][1] == "/v3/skill/update"
    c.patch("sk-1", expected_version=2, old_string="a", new_string="b", replace_all=True)
    assert stub.calls[-1][2]["replace_all"] is True
    c.delete("sk-1", expected_version=1)
    assert stub.calls[-1][1] == "/v3/skill/delete"
    c.get("sk-1", version=3, include_content=True, include_manifest=False)
    assert stub.calls[-1][1] == "/v3/skill/get"
    c.list(filters={"status": ["active"]}, pagination={"page": 1})
    assert stub.calls[-1][1] == "/v3/skill/list"
    c.search("q", top_k=5, mode="hybrid", scope="team")
    assert stub.calls[-1][1] == "/v3/skill/search"
    c.versions("sk-1", pagination={"page": 1})
    assert stub.calls[-1][1] == "/v3/skill/versions"
    c.write_files("sk-1", expected_version=2, files=[{"path": "a"}])
    assert stub.calls[-1][1] == "/v3/skill/files/write"
    c.remove_files("sk-1", expected_version=2, paths=["a"])
    assert stub.calls[-1][1] == "/v3/skill/files/remove"
    c.read_file("sk-1", "a", version=1, encoding="base64")
    assert stub.calls[-1][1] == "/v3/skill/files/read"
    c.export_skill("sk-1", version=1, format="zip")
    assert stub.calls[-1][1] == "/v3/skill/export"
    c.listing(query="x", char_budget=100)
    assert stub.calls[-1][1] == "/v3/skill/listing"
    c.close()
    assert stub.closed


def test_get_by_name():
    c, stub = _sync(**IDS)
    c.get_by_name("my-skill", team_id="t", agent_id="a", version=2,
                  include_content=True, user_id="u", task_id="tk")
    body = stub.calls[-1][2]
    assert stub.calls[-1][1] == "/v3/skill/get-by-name"
    assert body["skill_name"] == "my-skill" and body["team_id"] == "t"
    for kwargs in (dict(team_id="", agent_id="a"), dict(team_id="t", agent_id="")):
        with pytest.raises(ParamError):
            c.get_by_name("x", **kwargs)
    with pytest.raises(ParamError):
        c.get_by_name("  ", team_id="t", agent_id="a")
    # defaults are NOT merged — explicit ids required even when set
    c2, _ = _sync()
    with pytest.raises(TypeError):
        c2.get_by_name("x")


def test_extract_and_conversation():
    c, stub = _sync(**IDS)
    c.extract([{"role": "user", "content": "hi"}], session_id="s", reason="why",
              options={}, space_id="sp")
    assert stub.calls[-1][1] == "/v3/skill/extract"
    bare, _ = _sync()
    with pytest.raises(ParamError):
        bare.extract([{"m": 1}])
    with pytest.raises(ParamError):
        c.extract([])
    c.conversation_add(session_id="s", user_id="u", team_id="t", agent_id="a",
                       messages=[{"role": "user", "content": "x"}], space_id="sp", task_id="tk")
    assert stub.calls[-1][1] == "/v3/skill/conversation/add"
    with pytest.raises(ParamError):
        c.conversation_add(session_id="s", user_id="u", team_id="t", agent_id="a", messages=[])
    with pytest.raises(ParamError):
        c.conversation_add(session_id="", user_id="u", team_id="t", agent_id="a",
                           messages=[{"m": 1}])
    c.conversation_force_archive(session_id="s", user_id="u", team_id="t", agent_id="a",
                                 space_id="sp", reason="done", task_id="tk")
    assert stub.calls[-1][1] == "/v3/skill/conversation/force-archive"
    with pytest.raises(ParamError):
        c.conversation_force_archive(session_id="s", user_id="u", team_id="t",
                                     agent_id="a", space_id="")
    c.close()


@pytest.mark.asyncio
async def test_async_mirror():
    with pytest.raises(ParamError):
        AsyncSkillClient(endpoint="http://e", api_key="k")
    c = AsyncSkillClient(endpoint="http://e", api_key="k", service_id="s",
                         stub=FakeAsyncStub(), **IDS)
    stub = c._stub
    c2 = c.with_defaults(agent_id="a2")
    await c2.list()
    assert stub.calls[-1][2]["agent_id"] == "a2"
    assert AsyncSkillClient.encode_utf8("a", "b")["encoding"] == "utf-8"
    assert AsyncSkillClient.encode_base64("a", b"x")["encoding"] == "base64"
    await c.create(name="n", content="c")
    await c.update("sk", expected_version=1, content="c")
    await c.patch("sk", expected_version=1, old_string="a", new_string="b")
    await c.delete("sk", expected_version=1)
    await c.get("sk")
    await c.get_by_name("n", team_id="t", agent_id="a")
    with pytest.raises(ParamError):
        await c.get_by_name("", team_id="t", agent_id="a")
    await c.list()
    await c.search("q")
    await c.versions("sk")
    await c.write_files("sk", expected_version=1, files=[{}])
    await c.remove_files("sk", expected_version=1, paths=["a"])
    await c.read_file("sk", "a")
    await c.export_skill("sk")
    await c.listing()
    await c.extract([{"m": 1}])
    with pytest.raises(ParamError):
        await c.extract([])
    await c.conversation_add(session_id="s", user_id="u", team_id="t", agent_id="a",
                             messages=[{"m": 1}])
    with pytest.raises(ParamError):
        await c.conversation_add(session_id="s", user_id="u", team_id="t", agent_id="a", messages=[])
    await c.conversation_force_archive(session_id="s", user_id="u", team_id="t",
                                       agent_id="a", space_id="sp")
    with pytest.raises(ParamError):
        await c.conversation_force_archive(session_id="s", user_id="", team_id="t",
                                           agent_id="a", space_id="sp")
    paths = [call[1] for call in stub.calls]
    assert "/v3/skill/create" in paths and "/v3/skill/conversation/force-archive" in paths
    async with c:
        pass
    assert stub.closed
