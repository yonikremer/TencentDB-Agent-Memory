"""Shared fake transports for SDK unit tests (no network)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple


class FakeStub:
    """Synchronous fake transport recording (method, path, body)."""

    def __init__(self, result: Any = None) -> None:
        self.calls: List[Tuple[str, str, Any]] = []
        self.result = {} if result is None else result
        self.closed = False
        self.endpoint = "http://mem.example.com"
        self.headers = {
            "Authorization": "Bearer k",
            "x-tdai-service-id": "s",
        }

    def _ret(self) -> Any:
        return dict(self.result) if isinstance(self.result, dict) else self.result

    def post(self, path: str, body: Optional[Dict[str, Any]] = None, timeout: Any = None) -> Any:
        self.calls.append(("POST", path, body))
        return self._ret()

    def get(self, path: str, query: Optional[Dict[str, Any]] = None, timeout: Any = None) -> Any:
        self.calls.append(("GET", path, query))
        return self._ret()

    def close(self) -> None:
        self.closed = True


class FakeAsyncStub(FakeStub):
    async def post(self, path: str, body: Optional[Dict[str, Any]] = None, timeout: Any = None) -> Any:
        self.calls.append(("POST", path, body))
        return self._ret()

    async def get(self, path: str, query: Optional[Dict[str, Any]] = None, timeout: Any = None) -> Any:
        self.calls.append(("GET", path, query))
        return self._ret()

    async def close(self) -> None:
        self.closed = True


class FakeAsyncPostOnly:
    """Async transport without .get — exercises the async _get() POST fallback."""

    def __init__(self, result: Any = None) -> None:
        self.calls: List[Tuple[str, str, Any]] = []
        self.result = {} if result is None else result
        self.closed = False

    async def post(self, path: str, body: Optional[Dict[str, Any]] = None, timeout: Any = None) -> Any:
        self.calls.append(("POST", path, body))
        return dict(self.result) if isinstance(self.result, dict) else self.result

    async def close(self) -> None:
        self.closed = True


class PostOnlyStub(FakeStub):
    """Transport without .get — exercises the _get() POST fallback."""

    get = None  # type: ignore[assignment]


class FakeReader:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.closed = False

    def read(self, path: str) -> str:
        return f"content:{path}"

    def close(self) -> None:
        self.closed = True


class FakeAsyncReader(FakeReader):
    async def read(self, path: str) -> str:
        return f"content:{path}"

    async def close(self) -> None:
        self.closed = True


class FakeStsMgr:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.kwargs = kwargs

    def get_credential(self) -> object:
        return object()

    def invalidate(self) -> None:
        pass

    def close(self) -> None:
        pass
