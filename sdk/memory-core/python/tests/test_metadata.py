import pytest

from tencentdb_agent_memory.errors import ParamError
from tencentdb_agent_memory.v3 import AsyncMetadataClient, MetadataClient
from tencentdb_agent_memory.v3.metadata_client import _body, _require_any
from fakes import FakeAsyncStub, FakeStub


def _sync():
    stub = FakeStub()
    return MetadataClient(endpoint="http://e", api_key="k", service_id="s", stub=stub), stub


def test_helpers():
    assert _body({"a": 1, "b": None}) == {"a": 1}
    with pytest.raises(ParamError):
        _body([1])
    with pytest.raises(ParamError):
        _body("x")
    with pytest.raises(ParamError):
        _require_any({}, ("user_id", "user_key"), "op")
    with pytest.raises(ParamError):
        _require_any({"user_id": "  "}, ("user_id", "user_key"), "op")
    _require_any({"user_key": "k"}, ("user_id", "user_key"), "op")


def test_init_variants():
    with pytest.raises(ParamError):
        MetadataClient(endpoint="http://e", api_key="k")
    with pytest.raises(ParamError):
        MetadataClient(endpoint="http://e", service_id="s")
    real = MetadataClient(endpoint="http://e", api_key="k", service_id="s", user_key="uk")
    real.close()
    with MetadataClient(endpoint="http://e", api_key="k", service_id="s", stub=FakeStub()) as c:
        assert isinstance(c, MetadataClient)


def test_all_sync_endpoints():
    c, stub = _sync()
    c.create_user({"username": "a"})
    c.get_user("u1")
    c.get_user({"username": "a"})
    c.delete_users(["u1"])
    c.list_users("t1", pagination={"page": 1})
    c.list_users({"team_id": "t1"})
    c.list_users()
    c.create_user_key({"user_id": "u"})
    c.list_user_keys("u1")
    c.list_user_keys({"user_id": "u1"})
    c.get_user_key("k1")
    c.revoke_user_key("k1")
    c.update_user_key({"key_id": "k1"})
    c.create_team({"name": "t"})
    c.get_team("t1")
    c.update_team({"team_id": "t1"})
    c.delete_teams(["t1"])
    c.list_teams("u1")
    c.list_teams({"user_key": "uk"})
    c.list_teams("u1", pagination={"page": 2})
    with pytest.raises(ParamError):
        c.list_teams()
    with pytest.raises(ParamError):
        c.list_teams({"team_id": "t"})
    with pytest.raises(ParamError):
        c.create_user(["bad"])
    c.add_team_member({"team_id": "t", "user_id": "u"})
    c.remove_team_member("t", "u")
    c.list_team_members("t", pagination={"page": 1})
    c.get_team_member("t", "u")
    c.create_agent({"name": "a"})
    c.get_agent("a1")
    c.update_agent({"agent_id": "a1"})
    c.delete_agents(["a1"])
    c.list_agents({"team_id": "t"})
    c.archive_agent("a1")
    c.create_task({"title": "t"})
    c.get_task("task1")
    c.update_task({"task_id": "task1"})
    c.delete_tasks(["task1"])
    c.list_tasks("t1")
    c.list_tasks("t1", status="open", pagination={"page": 1})
    c.list_tasks({"creator_user_id": "u"})
    with pytest.raises(ParamError):
        c.list_tasks()
    with pytest.raises(ParamError):
        c.list_tasks({"team_id": ""})
    c.archive_task("task1")
    c.link_task_agent("task1", "a1", role_in_task="dev")
    c.link_task_agent("task1", "a1")
    c.unlink_task_agent("task1", "a1")
    c.list_task_agents("task1", pagination={"page": 1})
    c.append_participation_log({"task_id": "t"})
    c.list_participation_logs({"task_id": "t"})
    c.create_asset({"name": "a"})
    c.get_asset("as1")
    c.update_asset({"asset_id": "as1"})
    c.delete_assets(["as1"])
    c.list_assets({"team_id": "t"})
    c.list_accessible_assets({"user_id": "u"})
    c.touch_asset_usage("as1")
    c.set_agent_fixed_assets("a1", [{"asset_id": "as1"}])
    c.list_agent_fixed_assets("a1")
    c.list_agent_fixed_assets_with_detail({"agent_id": "a1"})
    c.summarize_agent_fixed_assets_by_agents({"agent_ids": ["a1"]})
    c.grant_acl({"asset_id": "as"})
    c.revoke_acl("acl1")
    c.list_acl("as1")
    c.check_acl({"asset_id": "as"})
    c.verify_auth("uk")
    c.get_instance_quota()
    c.get_user_config({"user_id": "u"})
    c.set_user_config({"user_id": "u"})
    c.create_knowledge({"team_id": "t"})
    c.get_knowledge("k1")
    c.get_knowledge("k1", "t1")
    c.update_knowledge({"knowledge_id": "k1"})
    c.delete_knowledge(["k1"])
    c.delete_knowledge(["k1"], "t1")
    c.list_knowledge({"team_id": "t"})
    paths = [call[1] for call in stub.calls]
    assert "/v3/meta/user/create" in paths
    assert "/v3/knowledge/list" in paths
    assert "/v3/meta/auth/verify" in paths
    c.close()
    assert stub.closed


@pytest.mark.asyncio
async def test_all_async_endpoints():
    with pytest.raises(ParamError):
        AsyncMetadataClient(endpoint="http://e", api_key="k")
    c = AsyncMetadataClient(endpoint="http://e", api_key="k", service_id="s", stub=FakeAsyncStub())
    stub = c._stub
    await c.create_user({"username": "a"})
    await c.get_user("u1")
    await c.delete_users(["u1"])
    await c.list_users("t1")
    await c.create_user_key({"user_id": "u"})
    await c.list_user_keys("u1")
    await c.get_user_key("k1")
    await c.revoke_user_key("k1")
    await c.update_user_key({"key_id": "k"})
    await c.create_team({"name": "t"})
    await c.get_team("t1")
    await c.update_team({"team_id": "t"})
    await c.delete_teams(["t"])
    await c.list_teams("u1")
    with pytest.raises(ParamError):
        await c.list_teams()
    await c.add_team_member({"team_id": "t"})
    await c.remove_team_member("t", "u")
    await c.list_team_members("t")
    await c.get_team_member("t", "u")
    await c.create_agent({"name": "a"})
    await c.get_agent("a1")
    await c.update_agent({"agent_id": "a"})
    await c.delete_agents(["a"])
    await c.list_agents({"team_id": "t"})
    await c.archive_agent("a")
    await c.create_task({"title": "t"})
    await c.get_task("t1")
    await c.update_task({"task_id": "t"})
    await c.delete_tasks(["t"])
    await c.list_tasks("t1")
    with pytest.raises(ParamError):
        await c.list_tasks({})
    await c.archive_task("t")
    await c.link_task_agent("t", "a")
    await c.unlink_task_agent("t", "a")
    await c.list_task_agents("t")
    await c.append_participation_log({"task_id": "t"})
    await c.list_participation_logs({"task_id": "t"})
    await c.create_asset({"name": "a"})
    await c.get_asset("a")
    await c.update_asset({"asset_id": "a"})
    await c.delete_assets(["a"])
    await c.list_assets({"team_id": "t"})
    await c.list_accessible_assets({"user_id": "u"})
    await c.touch_asset_usage("a")
    await c.set_agent_fixed_assets("a", [])
    await c.list_agent_fixed_assets("a")
    await c.list_agent_fixed_assets_with_detail({"agent_id": "a"})
    await c.summarize_agent_fixed_assets_by_agents({"agent_ids": []})
    await c.grant_acl({"asset_id": "a"})
    await c.revoke_acl("acl")
    await c.list_acl("a")
    await c.check_acl({"asset_id": "a"})
    await c.verify_auth("uk")
    await c.get_instance_quota()
    await c.get_user_config({"user_id": "u"})
    await c.set_user_config({"user_id": "u"})
    await c.create_knowledge({"team_id": "t"})
    await c.get_knowledge("k")
    await c.update_knowledge({"knowledge_id": "k"})
    await c.delete_knowledge(["k"])
    await c.list_knowledge({"team_id": "t"})
    async with c:
        pass
    assert stub.closed
