"""KS-plane client tests (wiki + ops + share helpers) with injected fake stubs."""

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tencentdb_agent_memory.errors import ParamError
from tencentdb_agent_memory.v3 import (
    AsyncOpsClient,
    AsyncWikiClient,
    MetadataClient,
    OpsClient,
    WikiClient,
)


class FakeStub:
    def __init__(self):
        self.calls = []

    def post(self, path, body):
        self.calls.append(("POST", path, body))
        return {"ok": True}

    def get(self, path):
        self.calls.append(("GET", path))
        return {"ok": True}


class AsyncFakeStub(FakeStub):
    async def post(self, path, body):
        return super().post(path, body)

    async def get(self, path):
        return super().get(path)


def test_wiki_create_write_ingest_paths():
    stub = FakeStub()
    w = WikiClient(endpoint="http://ks:8421", service_id="sid", stub=stub)
    w.create(team_id="t1", name="docs")
    w.raw_write(team_id="t1", wiki_id="wiki-1", files=[{"filename": "a.md", "content": "# hi"}])
    w.ingest(wiki_id="wiki-1")
    assert [c[1] for c in stub.calls] == ["/v3/wiki/create", "/v3/wiki/raw/write", "/v3/wiki/ingest"]
    assert stub.calls[1][2]["team_id"] == "t1"


def test_wiki_search_graph_opts_go_flat():
    stub = FakeStub()
    w = WikiClient(endpoint="http://ks:8421", service_id="sid", stub=stub)
    w.search("wiki-1", "q")
    assert "graph" not in stub.calls[0][2]
    w.search("wiki-1", "q", 10, {"hop": 2, "decay": 0.5, "minScore": 1})
    assert stub.calls[1][2]["hop"] == 2
    assert stub.calls[1][2]["decay"] == 0.5
    assert stub.calls[1][2]["minScore"] == 1


def test_wiki_search_rejects_bad_graph_opts():
    w = WikiClient(endpoint="http://ks:8421", service_id="sid", stub=FakeStub())
    with pytest.raises(ParamError):
        w.search("wiki-1", "q", 20, {"hop": 9})
    with pytest.raises(ParamError):
        w.search("wiki-1", "q", 20, {"decay": 2})
    with pytest.raises(ParamError):
        w.search("wiki-1", "q", 20, {"minScore": -1})
    with pytest.raises(ParamError):
        w.raw_write("t1", "wiki-1", [])


def test_ops_paths_and_validation():
    stub = FakeStub()
    ops = OpsClient(endpoint="http://ks:8421", service_id="sid", stub=stub)
    ops.llm_binding_set({"mode": "proxy", "api_key": "k", "proxy_base_url": "http://p"})
    ops.llm_binding_status()
    ops.llm_binding_list()
    ops.auto_sync_status()
    ops.auto_sync_trigger()
    assert stub.calls[0] == ("POST", "/v3/internal/llm-binding/set",
                              {"mode": "proxy", "api_key": "k", "proxy_base_url": "http://p"})
    assert stub.calls[3] == ("GET", "/v3/auto-sync/status")
    assert stub.calls[4][1] == "/v3/auto-sync/trigger"
    for bad in ({"mode": "x"}, {"mode": "proxy"}, {"mode": "byo"}):
        with pytest.raises(ParamError):
            ops.llm_binding_set(bad)


def test_share_helpers():
    stub = FakeStub()
    m = MetadataClient(endpoint="http://gw:8420", api_key="k", service_id="sid", stub=stub)
    m.share_asset_with_team("wiki-1")
    assert stub.calls[0] == ("POST", "/v3/meta/asset/update", {"asset_id": "wiki-1", "visibility": "team"})
    with pytest.raises(ParamError):
        m.set_asset_visibility("wiki-1", "everyone")


def test_ks_transport_needs_no_bearer():
    w = WikiClient(endpoint="http://ks:8421", service_id="sid")
    assert "Authorization" not in w._stub.headers
    assert w._stub.headers["x-tdai-service-id"] == "sid"
    w.close()
    o = OpsClient(endpoint="http://ks:8421", service_id="sid", api_key="tok")
    assert o._stub.headers["Authorization"] == "Bearer tok"
    o.close()


def test_gateway_clients_still_require_api_key():
    with pytest.raises(ParamError):
        MetadataClient(endpoint="http://gw:8420", api_key="", service_id="sid")


def test_async_surfaces():
    async def go():
        stub = AsyncFakeStub()
        w = AsyncWikiClient(endpoint="http://ks:8421", service_id="sid", stub=stub)
        await w.create(team_id="t1", name="docs")
        await w.search("wiki-1", "q", 5, {"hop": 1})
        ops = AsyncOpsClient(endpoint="http://ks:8421", service_id="sid", stub=stub)
        await ops.auto_sync_status()
        await ops.llm_binding_list()
        return stub.calls
    calls = asyncio.run(go())
    assert calls[0][1] == "/v3/wiki/create"
    assert calls[1][2]["hop"] == 1
    assert calls[2] == ("GET", "/v3/auto-sync/status")
