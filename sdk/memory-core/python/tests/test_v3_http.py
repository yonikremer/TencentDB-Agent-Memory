import httpx
import pytest

import tencentdb_agent_memory._v3_http as v3h
from tencentdb_agent_memory._v3_http import AsyncHttpStub, HttpStub
from tencentdb_agent_memory.errors import ParamError, TDAMError

EP = "http://mem.example.com/"


def _client(handler, async_=False):
    transport = httpx.MockTransport(handler)
    return (httpx.AsyncClient(transport=transport) if async_ else httpx.Client(transport=transport))


def _env(code=0, message="ok", data=None, request_id=None):
    body = {"code": code, "message": message}
    if data is not None:
        body["data"] = data
    if request_id is not None:
        body["request_id"] = request_id
    return body


def test_validate_transport_options():
    with pytest.raises(ParamError):
        HttpStub("", "k", "s")
    with pytest.raises(ParamError):
        HttpStub("   ", "k", "s")
    with pytest.raises(ParamError):
        HttpStub("ftp://mem.example.com", "k", "s")
    with pytest.raises(ParamError):
        HttpStub("http://", "k", "s")
    with pytest.raises(ParamError):
        HttpStub(EP, "  ", "s")
    with pytest.raises(ParamError):
        HttpStub(EP, "k", "")
    for bad in (True, 0, -1, "30", float("nan")):
        with pytest.raises(ParamError):
            HttpStub(EP, "k", "s", timeout=bad)
    s = HttpStub(EP, "k", "s", timeout=10, user_key="uk")
    assert s.headers["x-tdai-user-key"] == "uk"
    s.close()


def test_validate_unparsable_endpoint(monkeypatch):
    def boom(url):
        raise ValueError("nope")
    monkeypatch.setattr(v3h.httpx, "URL", boom)
    with pytest.raises(ParamError):
        HttpStub("http://x", "k", "s")


def test_post_success_and_trace():
    def handler(req):
        assert req.method == "POST"
        return httpx.Response(200, headers={"x-trace-id": "tid"}, json=_env(0, "ok", {"a": 1}))
    s = HttpStub(EP, "k", "s", client=_client(handler))
    assert s.post("/v3/x", {}, timeout=5.0) == {"a": 1, "trace_id": "tid"}
    s.close()


def test_post_success_null_data_no_trace():
    s = HttpStub(EP, "k", "s", client=_client(lambda req: httpx.Response(200, json=_env())))
    assert s.post("/v3/x", {}) == {}
    s.close()


def test_post_success_non_dict_data_raises():
    s = HttpStub(EP, "k", "s", client=_client(lambda req: httpx.Response(200, json=_env(0, "ok", "scalar"))))
    with pytest.raises(TDAMError) as ei:
        s.post("/v3/x", {})
    assert "must be a JSON object" in str(ei.value)
    s.close()


def test_get_builds_query_and_strips_none():
    seen = {}

    def handler(req):
        seen["url"] = str(req.url)
        return httpx.Response(200, json=_env(0, "ok", {}))
    s = HttpStub(EP, "k", "s", client=_client(handler))
    assert s.get("/v3/x", {"a": 1, "b": None}) == {}
    assert "a=1" in seen["url"] and "b=" not in seen["url"]
    assert s.get("/v3/x") == {}
    s.close()


def test_business_error_details_and_header_id():
    def handler(req):
        return httpx.Response(200, headers={"x-qcloud-transaction-id": "hdr"},
                              json=_env(40901, "stale", {"current_version": 2}))
    s = HttpStub(EP, "k", "s", client=_client(handler))
    with pytest.raises(TDAMError) as ei:
        s.post("/v3/skill/update", {})
    assert ei.value.code == 40901
    assert ei.value.request_id == "hdr"
    assert ei.value.details == {"current_version": 2}
    s.close()


def test_http_error_code_zero_uses_status_and_trace_fallback():
    def handler(req):
        return httpx.Response(500, headers={"x-trace-id": "tf"}, json={"code": 0, "message": ""})
    s = HttpStub(EP, "k", "s", client=_client(handler))
    with pytest.raises(TDAMError) as ei:
        s.post("/v3/x", {})
    assert ei.value.code == 500
    assert ei.value.request_id == "tf"
    assert "HTTP 500" in str(ei.value)
    s.close()


def test_missing_code_envelope_request_id_and_primitive_details():
    def handler(req):
        return httpx.Response(200, json={"message": "m", "data": "s", "request_id": "env-1"})
    s = HttpStub(EP, "k", "s", client=_client(handler))
    with pytest.raises(TDAMError) as ei:
        s.post("/v3/x", {})
    assert ei.value.code == 200
    assert ei.value.request_id == "env-1"
    assert ei.value.details is None
    s.close()


def test_non_json_bodies():
    s = HttpStub(EP, "k", "s", client=_client(lambda req: httpx.Response(200, text="")))
    with pytest.raises(TDAMError) as ei:
        s.post("/v3/x", {})
    assert ei.value.code == -1
    assert "non-JSON" in str(ei.value)
    s.close()
    s2 = HttpStub(EP, "k", "s", client=_client(lambda req: httpx.Response(400, text="<html>")))
    with pytest.raises(TDAMError) as ei2:
        s2.post("/v3/x", {})
    assert ei2.value.code == 400
    assert "<html>" in str(ei2.value)
    s2.close()


def test_non_dict_envelope_raises():
    s = HttpStub(EP, "k", "s", client=_client(lambda req: httpx.Response(200, json=[1, 2])))
    with pytest.raises(TDAMError):
        s.post("/v3/x", {})
    s.close()


def test_close_non_client_skips():
    s = HttpStub.__new__(HttpStub)
    s.client = object()
    s.close()


@pytest.mark.asyncio
async def test_async_post_get_and_errors():
    def handler(req):
        if req.method == "GET":
            return httpx.Response(200, json=_env(0, "ok", {"g": 1}))
        return httpx.Response(200, headers={"x-trace-id": "t"}, json=_env(0, "ok", {"p": 1}))
    s = AsyncHttpStub(EP, "k", "s", user_key="uk", client=_client(handler, async_=True))
    assert await s.post("/v3/x", {}) == {"p": 1, "trace_id": "t"}
    assert await s.get("/v3/x", {"q": "hi"}) == {"g": 1}
    assert await s.get("/v3/x") == {"g": 1}
    await s.close()
    s2 = AsyncHttpStub.__new__(AsyncHttpStub)
    s2.client = object()
    await s2.close()


@pytest.mark.asyncio
async def test_async_validation_and_non_json():
    with pytest.raises(ParamError):
        AsyncHttpStub("notaurl", "k", "s")
    s = AsyncHttpStub(EP, "k", "s", client=_client(lambda req: httpx.Response(200, text=""), async_=True))
    with pytest.raises(TDAMError):
        await s.post("/v3/x", {})
    await s.close()
