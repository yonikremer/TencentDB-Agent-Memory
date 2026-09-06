import time
from datetime import datetime, timedelta, timezone

import httpx
import pytest

import tencentdb_agent_memory.cos as cosmod
from tencentdb_agent_memory.cos import (
    AsyncMemoryFileReader,
    AsyncStsCredentialManager,
    MemoryFileReader,
    StsCredential,
    StsCredentialManager,
    _cos_v5_sign,
    _parse_cos_url,
)
from tencentdb_agent_memory.errors import TDAMError

FUTURE = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
PAST = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()


def sts_data(**kw):
    d = {
        "CosUrl": "https://mybucket.cos.ap-guangzhou.myqcloud.com",
        "TmpSecretId": "sid",
        "TmpSecretKey": "skey",
        "TmpToken": "tok-1",
        "ExpirationTime": FUTURE,
        "PathPrefix": "mem/abc",
    }
    d.update(kw)
    return d


def test_parse_cos_url_public_and_internal():
    assert _parse_cos_url("https://b.cos.ap-guangzhou.myqcloud.com") == ("b", "ap-guangzhou")
    assert _parse_cos_url("https://b.cos-internal.nanjing.tencentcos.cn") == ("b", "nanjing")


def test_parse_cos_url_bad_host():
    with pytest.raises(TDAMError):
        _parse_cos_url("https://example.com/plain")
    with pytest.raises(TDAMError):
        _parse_cos_url("not a url at all")


def test_parse_cos_url_hostname_crash(monkeypatch):
    def boom(url):
        raise ValueError("bad")
    monkeypatch.setattr(cosmod, "urlparse", boom)
    with pytest.raises(TDAMError):
        _parse_cos_url("http://x")


def test_credential_fields_prefix_expiry():
    c = StsCredential(sts_data())
    assert (c.bucket, c.region) == ("mybucket", "ap-guangzhou")
    assert c.cos_host == "mybucket.cos.ap-guangzhou.myqcloud.com"
    assert c.prefix == "mem/abc/"
    assert c.token == "tok-1"
    assert c.is_valid()
    c2 = StsCredential(sts_data(PathPrefix="p/", TmpToken="", ExpirationTime="2026-05-15T16:44:49Z"))
    assert c2.prefix == "p/" and c2.token == ""
    c3 = StsCredential(sts_data(PathPrefix="internal", CosUrl="https://b.cos-internal.nj.tencentcos.cn"))
    assert c3.prefix == "internal/" and c3.region == "nj"


def test_credential_expiry_fallbacks():
    c = StsCredential(sts_data(ExpirationTime=""))
    assert abs(c.expires_at_epoch - (time.time() + 1800)) < 60
    c2 = StsCredential(sts_data(ExpirationTime="garbage-not-a-date"))
    assert abs(c2.expires_at_epoch - (time.time() + 1800)) < 60
    d = sts_data()
    del d["ExpirationTime"]
    c3 = StsCredential(d)
    assert c3.expires_at_epoch > time.time()
    d2 = sts_data()
    del d2["PathPrefix"]
    assert StsCredential(d2).prefix == "/"


def test_credential_is_valid_buffer_and_expired():
    soon = (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat()
    c = StsCredential(sts_data(ExpirationTime=soon))
    assert not c.is_valid()
    assert not c.is_valid(600000.0)
    assert not StsCredential(sts_data(ExpirationTime=PAST)).is_valid()


def _mgr_with_transport(data, **kw):
    mgr = StsCredentialManager("http://mem.example.com/", "k", "s", **kw)
    calls = []

    def handler(req):
        calls.append(req)
        return httpx.Response(200, json=data)

    mgr._client = httpx.Client(transport=httpx.MockTransport(handler))
    mgr._calls = calls
    return mgr


def test_manager_fetch_cache_invalidate():
    mgr = _mgr_with_transport(sts_data())
    c1 = mgr.get_credential()
    c2 = mgr.get_credential()
    assert c1 is c2 and len(mgr._calls) == 1
    assert mgr._calls[0].url.path == "/v2/cos/secret"
    mgr.invalidate()
    mgr.get_credential()
    assert len(mgr._calls) == 2
    mgr.close()


def test_manager_expired_triggers_refresh_and_double_check(monkeypatch):
    mgr = _mgr_with_transport(sts_data())
    mgr._credential = StsCredential(sts_data(ExpirationTime=PAST))
    fresh = mgr.get_credential()
    assert fresh.is_valid() and len(mgr._calls) == 1
    # inner double-check hit: outer check fails, inner passes
    mgr._credential = StsCredential(sts_data())
    orig_valid = StsCredential.is_valid
    calls = {"n": 0}

    def flaky(self, buffer_seconds=120):
        calls["n"] += 1
        return False if calls["n"] == 1 else orig_valid(self, buffer_seconds)

    monkeypatch.setattr(StsCredential, "is_valid", flaky)
    assert mgr.get_credential() is mgr._credential
    assert len(mgr._calls) == 1  # no refresh happened
    mgr.close()


def test_manager_bad_cos_url_propagates():
    mgr = _mgr_with_transport(sts_data(CosUrl="bad url"))
    with pytest.raises(TDAMError):
        mgr.get_credential()


def test_manager_close_without_client():
    StsCredentialManager("http://e", "k", "s").close()


def test_sign_defaults_and_explicit():
    sig = _cos_v5_sign("sid", "skey", "GET", "/mem/a.md", "b.cos.r.myqcloud.com")
    assert "q-sign-algorithm=sha1" in sig and "q-ak=sid" in sig
    assert len(sig.split("q-signature=")[1]) == 40
    a = _cos_v5_sign("sid", "skey", "GET", "/f", "h", 1000, 2000)
    assert a == _cos_v5_sign("sid", "skey", "GET", "/f", "h", 1000, 2000)
    assert "1000;2000" in a


class _FakeSts:
    def __init__(self, cred):
        self.cred = cred
        self.invalidated = 0

    def get_credential(self):
        return self.cred

    def invalidate(self):
        self.invalidated += 1


def _reader_client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_reader_200_with_token_headers():
    seen = {}

    def handler(req):
        seen.update(req.headers)
        return httpx.Response(200, text="# persona")

    r = MemoryFileReader(_FakeSts(StsCredential(sts_data())), client=_reader_client(handler))
    assert r.read("persona.md") == "# persona"
    assert seen["x-cos-security-token"] == "tok-1"
    assert "q-sign-algorithm=sha1" in seen["authorization"]
    r.close()


def test_reader_200_without_token():
    seen = {}

    def handler(req):
        seen.update(req.headers)
        return httpx.Response(200, text="x")

    r = MemoryFileReader(_FakeSts(StsCredential(sts_data(TmpToken=""))), client=_reader_client(handler))
    assert r.read("f.md") == "x"
    assert "x-cos-security-token" not in seen
    r.close()


def test_reader_403_retry_then_ok():
    responses = [httpx.Response(403, text="expired"), httpx.Response(200, text="fresh")]
    sts = _FakeSts(StsCredential(sts_data()))
    r = MemoryFileReader(sts, client=_reader_client(lambda req: responses.pop(0)))
    assert r.read("f.md") == "fresh"
    assert sts.invalidated == 1
    r.close()


def test_reader_403_retry_fails_404_and_500():
    sts = _FakeSts(StsCredential(sts_data()))
    r = MemoryFileReader(sts, client=_reader_client(lambda req: httpx.Response(403, text="no")))
    with pytest.raises(TDAMError) as ei:
        r.read("f.md")
    assert ei.value.code == 403 and "COS GET failed" in str(ei.value)
    r.close()
    r404 = MemoryFileReader(_FakeSts(StsCredential(sts_data())),
                            client=_reader_client(lambda req: httpx.Response(404, text="")))
    with pytest.raises(TDAMError) as ei2:
        r404.read("missing.md")
    assert ei2.value.code == 404 and "File not found" in str(ei2.value)
    r404.close()
    long_body = "e" * 500
    r500 = MemoryFileReader(_FakeSts(StsCredential(sts_data(TmpToken=""))),
                            client=_reader_client(lambda req: httpx.Response(500, text=long_body)))
    with pytest.raises(TDAMError) as ei3:
        r500.read("f.md")
    assert ei3.value.code == 500 and len(ei3.value.message) < len(long_body) + 100
    r500.close()


def test_reader_close_non_client():
    r = MemoryFileReader.__new__(MemoryFileReader)
    r._client = object()
    r.close()


@pytest.mark.asyncio
async def test_async_manager_and_reader():
    mgr = AsyncStsCredentialManager("http://mem.example.com", "k", "s")

    async def fake_post(url, json=None, headers=None):
        class _R:
            def raise_for_status(self):
                pass

            def json(self):
                return sts_data()
        return _R()

    class _FakeAsyncClient:
        async def post(self, *a, **k):
            return await fake_post(*a, **k)

        async def aclose(self):
            pass

    mgr._client = _FakeAsyncClient()
    c1 = await mgr.get_credential()
    assert c1.bucket == "mybucket"
    assert await mgr.get_credential() is c1
    mgr.invalidate()
    assert mgr._credential is None
    await mgr.get_credential()
    await mgr.close()
    AsyncStsCredentialManager("http://e", "k", "s").invalidate()
    await AsyncStsCredentialManager("http://e", "k", "s").close()


@pytest.mark.asyncio
async def test_async_manager_double_check(monkeypatch):
    mgr = AsyncStsCredentialManager("http://e", "k", "s")
    mgr._credential = StsCredential(sts_data())
    orig_valid = StsCredential.is_valid
    calls = {"n": 0}

    def flaky(self, buffer_seconds=120):
        calls["n"] += 1
        return False if calls["n"] == 1 else orig_valid(self, buffer_seconds)

    monkeypatch.setattr(StsCredential, "is_valid", flaky)
    assert await mgr.get_credential() is mgr._credential


class _FakeAsyncSts:
    def __init__(self, cred):
        self.cred = cred
        self.invalidated = 0

    async def get_credential(self):
        return self.cred

    def invalidate(self):
        self.invalidated += 1


@pytest.mark.asyncio
async def test_async_reader_paths():
    def ok_client(text, status=200):
        return httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(status, text=text)))

    r = AsyncMemoryFileReader(_FakeAsyncSts(StsCredential(sts_data())), client=ok_client("hi"))
    assert await r.read("a.md") == "hi"
    await r.close()
    rn = AsyncMemoryFileReader(_FakeAsyncSts(StsCredential(sts_data(TmpToken=""))), client=ok_client("x"))
    assert await rn.read("a.md") == "x"
    await rn.close()
    seq = [httpx.Response(403, text="e"), httpx.Response(200, text="fresh2")]
    sts = _FakeAsyncSts(StsCredential(sts_data()))
    rr = AsyncMemoryFileReader(sts, client=httpx.AsyncClient(
        transport=httpx.MockTransport(lambda req: seq.pop(0))))
    assert await rr.read("f.md") == "fresh2"
    assert sts.invalidated == 1
    await rr.close()
    r404 = AsyncMemoryFileReader(_FakeAsyncSts(StsCredential(sts_data())), client=ok_client("", 404))
    with pytest.raises(TDAMError):
        await r404.read("m.md")
    await r404.close()
    r500 = AsyncMemoryFileReader(_FakeAsyncSts(StsCredential(sts_data())), client=ok_client("bad", 500))
    with pytest.raises(TDAMError):
        await r500.read("f.md")
    await r500.close()
    rc = AsyncMemoryFileReader.__new__(AsyncMemoryFileReader)
    rc._client = object()
    await rc.close()
