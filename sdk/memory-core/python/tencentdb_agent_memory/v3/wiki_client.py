"""TencentDB Agent Memory v3 Wiki SDK — Knowledge Service data-plane ``/v3/wiki/*`` (15 endpoints).

Asset layer: create / get / list / delete / update-meta / ingest.
File layer: raw/{ls,read,write,rm} + page/{ls,read,write,rm}.
Derived: graph / search (graph-expansion options go flat: hop/decay/minScore).

Auth: ``x-tdai-service-id`` always (shared ``HttpStub``); ``Bearer`` only
when ``api_key`` is given (KS standalone needs none). Team-scoped writes
carry ``team_id`` (+ optional ``user_id``); id-only reads address by ``wiki_id``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..errors import ParamError
from ._common import flat_graph_options, ks_stub, need, strip_none

_V3 = "/v3/wiki"


class _WikiMethodsMixin:
    _stub: Any

    def _create(self, team_id: str, name: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/create", strip_none({"team_id": need("team_id", team_id), "name": need("name", name), "user_id": user_id}))

    def _get(self, wiki_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/get", {"wiki_id": need("wiki_id", wiki_id)})

    def _list(self, team_id: str, status: Optional[str] = None, limit: Optional[int] = None, offset: Optional[int] = None) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/list", strip_none({"team_id": need("team_id", team_id), "status": status, "limit": limit, "offset": offset}))

    def _delete(self, wiki_ids: List[str]) -> Dict[str, Any]:
        if not wiki_ids:
            raise ParamError("delete requires non-empty wiki_ids")
        return self._stub.post(f"{_V3}/delete", {"wiki_ids": wiki_ids})

    def _update_meta(self, wiki_id: str, name: Optional[str] = None, summary: Optional[str] = None) -> Dict[str, Any]:
        if not name and summary is None:
            raise ParamError("update_meta requires name or summary")
        return self._stub.post(f"{_V3}/update-meta", strip_none({"wiki_id": need("wiki_id", wiki_id), "name": name, "summary": summary}))

    def _raw_write(self, team_id: str, wiki_id: str, files: List[Dict[str, Any]], user_id: Optional[str] = None) -> Dict[str, Any]:
        if not files:
            raise ParamError("raw_write requires non-empty files")
        return self._stub.post(f"{_V3}/raw/write", strip_none({"team_id": need("team_id", team_id), "user_id": user_id, "wiki_id": need("wiki_id", wiki_id), "files": files}))

    def _raw_ls(self, wiki_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/raw/ls", {"wiki_id": need("wiki_id", wiki_id)})

    def _raw_read(self, wiki_id: str, filenames: List[str]) -> Dict[str, Any]:
        if not filenames:
            raise ParamError("raw_read requires non-empty filenames")
        return self._stub.post(f"{_V3}/raw/read", {"wiki_id": need("wiki_id", wiki_id), "filenames": filenames})

    def _raw_rm(self, team_id: str, wiki_id: str, filenames: List[str], user_id: Optional[str] = None) -> Dict[str, Any]:
        if not filenames:
            raise ParamError("raw_rm requires non-empty filenames")
        return self._stub.post(f"{_V3}/raw/rm", strip_none({"team_id": need("team_id", team_id), "user_id": user_id, "wiki_id": need("wiki_id", wiki_id), "filenames": filenames}))

    def _page_ls(self, wiki_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/page/ls", {"wiki_id": need("wiki_id", wiki_id)})

    def _page_read(self, wiki_id: str, refs: List[str]) -> Dict[str, Any]:
        if not refs:
            raise ParamError("page_read requires non-empty refs")
        return self._stub.post(f"{_V3}/page/read", {"wiki_id": need("wiki_id", wiki_id), "refs": refs})

    def _page_write(self, team_id: str, wiki_id: str, pages: List[Dict[str, Any]], user_id: Optional[str] = None) -> Dict[str, Any]:
        if not pages:
            raise ParamError("page_write requires non-empty pages")
        return self._stub.post(f"{_V3}/page/write", strip_none({"team_id": need("team_id", team_id), "user_id": user_id, "wiki_id": need("wiki_id", wiki_id), "pages": pages}))

    def _page_rm(self, team_id: str, wiki_id: str, refs: List[str], user_id: Optional[str] = None) -> Dict[str, Any]:
        if not refs:
            raise ParamError("page_rm requires non-empty refs")
        return self._stub.post(f"{_V3}/page/rm", strip_none({"team_id": need("team_id", team_id), "user_id": user_id, "wiki_id": need("wiki_id", wiki_id), "refs": refs}))

    def _ingest(self, wiki_id: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/ingest", strip_none({"wiki_id": need("wiki_id", wiki_id), "user_id": user_id}))

    def _graph(self, wiki_id: str) -> Dict[str, Any]:
        return self._stub.post(f"{_V3}/graph", {"wiki_id": need("wiki_id", wiki_id)})

    def _search(self, wiki_id: str, query: str, limit: int = 20, graph: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        need("query", query)
        body: Dict[str, Any] = {"wiki_id": need("wiki_id", wiki_id), "query": query, "limit": limit}
        body.update(flat_graph_options(graph))
        return self._stub.post(f"{_V3}/search", body)


class WikiClient(_WikiMethodsMixin):
    def __init__(self, endpoint: str = "", service_id: Optional[str] = None, *, api_key: str = "", user_key: Optional[str] = None, timeout: float = 30, verify: bool = True, stub: Optional[Any] = None) -> None:
        self._stub = stub if stub is not None else ks_stub(endpoint, service_id, api_key=api_key, timeout=timeout, verify=verify, user_key=user_key)

    def create(self, team_id: str, name: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        return self._create(team_id, name, user_id)

    def get(self, wiki_id: str) -> Dict[str, Any]:
        return self._get(wiki_id)

    def list(self, team_id: str, status: Optional[str] = None, limit: Optional[int] = None, offset: Optional[int] = None) -> Dict[str, Any]:
        return self._list(team_id, status, limit, offset)

    def delete(self, wiki_ids: List[str]) -> Dict[str, Any]:
        return self._delete(wiki_ids)

    def update_meta(self, wiki_id: str, name: Optional[str] = None, summary: Optional[str] = None) -> Dict[str, Any]:
        return self._update_meta(wiki_id, name, summary)

    def raw_write(self, team_id: str, wiki_id: str, files: List[Dict[str, Any]], user_id: Optional[str] = None) -> Dict[str, Any]:
        return self._raw_write(team_id, wiki_id, files, user_id)

    def raw_ls(self, wiki_id: str) -> Dict[str, Any]:
        return self._raw_ls(wiki_id)

    def raw_read(self, wiki_id: str, filenames: List[str]) -> Dict[str, Any]:
        return self._raw_read(wiki_id, filenames)

    def raw_rm(self, team_id: str, wiki_id: str, filenames: List[str], user_id: Optional[str] = None) -> Dict[str, Any]:
        return self._raw_rm(team_id, wiki_id, filenames, user_id)

    def page_ls(self, wiki_id: str) -> Dict[str, Any]:
        return self._page_ls(wiki_id)

    def page_read(self, wiki_id: str, refs: List[str]) -> Dict[str, Any]:
        return self._page_read(wiki_id, refs)

    def page_write(self, team_id: str, wiki_id: str, pages: List[Dict[str, Any]], user_id: Optional[str] = None) -> Dict[str, Any]:
        return self._page_write(team_id, wiki_id, pages, user_id)

    def page_rm(self, team_id: str, wiki_id: str, refs: List[str], user_id: Optional[str] = None) -> Dict[str, Any]:
        return self._page_rm(team_id, wiki_id, refs, user_id)

    def ingest(self, wiki_id: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        return self._ingest(wiki_id, user_id)

    def graph(self, wiki_id: str) -> Dict[str, Any]:
        return self._graph(wiki_id)

    def search(self, wiki_id: str, query: str, limit: int = 20, graph: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._search(wiki_id, query, limit, graph)

    def close(self) -> None:
        c = getattr(self._stub, "close", None)
        if callable(c):
            c()

    def __enter__(self) -> "WikiClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class AsyncWikiClient(_WikiMethodsMixin):
    def __init__(self, endpoint: str = "", service_id: Optional[str] = None, *, api_key: str = "", user_key: Optional[str] = None, timeout: float = 30, verify: bool = True, stub: Optional[Any] = None) -> None:
        self._stub = stub if stub is not None else ks_stub(endpoint, service_id, api_key=api_key, timeout=timeout, verify=verify, user_key=user_key, async_=True)

    async def create(self, team_id: str, name: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        return await self._create(team_id, name, user_id)

    async def get(self, wiki_id: str) -> Dict[str, Any]:
        return await self._get(wiki_id)

    async def list(self, team_id: str, status: Optional[str] = None, limit: Optional[int] = None, offset: Optional[int] = None) -> Dict[str, Any]:
        return await self._list(team_id, status, limit, offset)

    async def delete(self, wiki_ids: List[str]) -> Dict[str, Any]:
        return await self._delete(wiki_ids)

    async def update_meta(self, wiki_id: str, name: Optional[str] = None, summary: Optional[str] = None) -> Dict[str, Any]:
        return await self._update_meta(wiki_id, name, summary)

    async def raw_write(self, team_id: str, wiki_id: str, files: List[Dict[str, Any]], user_id: Optional[str] = None) -> Dict[str, Any]:
        return await self._raw_write(team_id, wiki_id, files, user_id)

    async def raw_ls(self, wiki_id: str) -> Dict[str, Any]:
        return await self._raw_ls(wiki_id)

    async def raw_read(self, wiki_id: str, filenames: List[str]) -> Dict[str, Any]:
        return await self._raw_read(wiki_id, filenames)

    async def raw_rm(self, team_id: str, wiki_id: str, filenames: List[str], user_id: Optional[str] = None) -> Dict[str, Any]:
        return await self._raw_rm(team_id, wiki_id, filenames, user_id)

    async def page_ls(self, wiki_id: str) -> Dict[str, Any]:
        return await self._page_ls(wiki_id)

    async def page_read(self, wiki_id: str, refs: List[str]) -> Dict[str, Any]:
        return await self._page_read(wiki_id, refs)

    async def page_write(self, team_id: str, wiki_id: str, pages: List[Dict[str, Any]], user_id: Optional[str] = None) -> Dict[str, Any]:
        return await self._page_write(team_id, wiki_id, pages, user_id)

    async def page_rm(self, team_id: str, wiki_id: str, refs: List[str], user_id: Optional[str] = None) -> Dict[str, Any]:
        return await self._page_rm(team_id, wiki_id, refs, user_id)

    async def ingest(self, wiki_id: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        return await self._ingest(wiki_id, user_id)

    async def graph(self, wiki_id: str) -> Dict[str, Any]:
        return await self._graph(wiki_id)

    async def search(self, wiki_id: str, query: str, limit: int = 20, graph: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return await self._search(wiki_id, query, limit, graph)
