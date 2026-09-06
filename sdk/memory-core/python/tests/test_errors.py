from tencentdb_agent_memory.errors import ParamError, TDAMError


def test_tdam_str_with_request_id():
    err = TDAMError(40001, "bad", "req-1", {"a": 1})
    assert err.code == 40001
    assert err.message == "bad"
    assert err.request_id == "req-1"
    assert err.details == {"a": 1}
    assert "40001" in str(err) and "req-1" in str(err)


def test_tdam_defaults_no_request_id_no_details():
    err = TDAMError(1, "x")
    assert err.request_id == ""
    assert err.details is None
    assert "request_id" not in str(err)


def test_tdam_details_copied():
    src = {"v": 2}
    err = TDAMError(40901, "stale", "r", src)
    assert err.details == src and err.details is not src


def test_param_error_is_exception():
    err = ParamError("nope")
    assert isinstance(err, Exception)
    assert "nope" in str(err)
