import httpx
import pytest

from tencentdb_agent_memory._http import AsyncHttpStub, HttpStub
from tencentdb_agent_memory.errors import TDAMError

EP = "http://mem.example.com/"


def _client(handler, async_=False):
    transport = httpx.MockTransport(handler)
    return (httpx.AsyncClient(transport=transport) if async_ else httpx.Client(transport=transport))


def _ok(request, data=None, trace=None):
    headers = {}
    if trace:
        headers["x-trace-id"] = trace
    return httpx.Response(200, headers=headers, json={"code": 0, "message": "ok", "data": data})


def test_init_headers_and_endpoint_strip():
    s = HttpStub(EP, "k", "svc", user_key="uk")
    assert s.endpoint == "http://mem.example.com"
    assert s.headers["Authorization"] == "Bearer k"
    assert s.headers["x-tdai-service-id"] == "svc"
    assert s.headers["x-tdai-user-key"] == "uk"
    s.close()
    s2 = HttpStub(EP, "k", "svc")
    assert "x-tdai-user-key" not in s2.headers
    s2.close()


def test_post_success_with_trace():
    c = _client(lambda req: _ok(req, {"a": 1}, trace="t-1"))
    s = HttpStub(EP, "k", "svc", client=c)
    assert s.post("/v2/x", {}) == {"a": 1, "trace_id": "t-1"}
    s.close()


def test_post_success_null_data_with_trace_returns_empty_dict():
    c = _client(lambda req: _ok(req, None, trace="t-2"))
    s = HttpStub(EP, "k", "svc", client=c)
    assert s.post("/v2/x", {}) == {"trace_id": "t-2"}
    s.close()


def test_post_success_list_data_with_trace_skips_trace():
    c = _client(lambda req: _ok(req, [1, 2], trace="t-3"))
    s = HttpStub(EP, "k", "svc", client=c)
    assert s.post("/v2/x", {}) == [1, 2]
    s.close()


def test_post_success_no_trace_no_data_key():
    c = _client(lambda req: httpx.Response(200, json={"code": 0, "message": "ok"}))
    s = HttpStub(EP, "k", "svc", client=c)
    assert s.post("/v2/x", {}) == {}
    s.close()


def test_post_explicit_timeout_used():
    seen = {}

    def handler(req):
        seen["timeout"] = True
        return _ok(req, {})

    c = _client(handler)
    s = HttpStub(EP, "k", "svc", client=c)
    s.post("/v2/x", {}, timeout=5.0)
    assert seen["timeout"]
    s.close()


def test_post_business_error_with_header_id_and_details():
    def handler(req):
        return httpx.Response(200, headers={"x-qcloud-transaction-id": "tx-9"},
                              json={"code": 40001, "message": "bad", "data": {"v": 3}})
    s = HttpStub(EP, "k", "svc", client=_client(handler))
    with pytest.raises(TDAMError) as ei:
        s.post("/v2/x", {})
    assert ei.value.code == 40001
    assert ei.value.request_id == "tx-9"
    assert ei.value.details == {"v": 3}
    s.close()


def test_post_business_error_envelope_request_id_primitive_details():
    def handler(req):
        return httpx.Response(200, json={"code": 41002, "message": "exp",
                                         "request_id": "r-77", "data": "str"})
    s = HttpStub(EP, "k", "svc", client=_client(handler))
    with pytest.raises(TDAMError) as ei:
        s.post("/v2/x", {})
    assert ei.value.request_id == "r-77"
    assert ei.value.details is None
    s.close()


def test_post_business_error_missing_code_and_message():
    def handler(req):
        return httpx.Response(200, json={})
    s = HttpStub(EP, "k", "svc", client=_client(handler))
    with pytest.raises(TDAMError) as ei:
        s.post("/v2/x", {})
    assert ei.value.code == -1
    assert ei.value.message == "unknown error"
    s.close()


def test_post_http_error_propagates():
    s = HttpStub(EP, "k", "svc", client=_client(lambda req: httpx.Response(503, text="down")))
    with pytest.raises(httpx.HTTPStatusError):
        s.post("/v2/x", {})
    s.close()


def test_close_with_non_httpx_client_skips():
    s = HttpStub.__new__(HttpStub)
    s.client = object()
    s.close()  # must not raise


@pytest.mark.asyncio
async def test_async_post_success_and_trace():
    c = _client(lambda req: _ok(req, {"a": 1}, trace="ta"), async_=True)
    s = AsyncHttpStub(EP, "k", "svc", client=c)
    assert s.endpoint == "http://mem.example.com"
    assert await s.post("/v2/x", {}) == {"a": 1, "trace_id": "ta"}
    await s.close()


@pytest.mark.asyncio
async def test_async_post_null_data_and_business_error():
    c = _client(lambda req: _ok(req, None), async_=True)
    s = AsyncHttpStub(EP, "k", "svc", user_key="uk", client=c)
    assert s.headers["x-tdai-user-key"] == "uk"
    assert await s.post("/v2/x", {}, timeout=7.0) == {}

    def err_handler(req):
        return httpx.Response(200, json={"code": 1, "message": "m", "data": {"d": 1}})
    s2 = AsyncHttpStub(EP, "k", "svc", client=_client(err_handler, async_=True))
    with pytest.raises(TDAMError) as ei:
        await s2.post("/v2/x", {})
    assert ei.value.details == {"d": 1}
    await s2.close()


@pytest.mark.asyncio
async def test_async_post_http_error_and_close_variants():
    s = AsyncHttpStub(EP, "k", "svc",
                      client=_client(lambda req: httpx.Response(500, text="boom"), async_=True))
    with pytest.raises(httpx.HTTPStatusError):
        await s.post("/v2/x", {})
    await s.close()
    s2 = AsyncHttpStub.__new__(AsyncHttpStub)
    s2.client = object()
    await s2.close()
