"""Shared helpers for KS-plane clients (wiki + ops)."""

from __future__ import annotations

from typing import Any, Dict, Optional

from .._v3_http import AsyncHttpStub, HttpStub
from ..errors import ParamError

#: Asset visibility values accepted by ``asset/update`` (mirrors gateway schema).
VISIBILITIES = ("private", "team", "restricted", "agent", "task")


def strip_none(d: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def need(name: str, value: Optional[str]) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ParamError(f"requires non-empty {name}")
    return value


def check_visibility(visibility: str) -> str:
    if visibility not in VISIBILITIES:
        raise ParamError(f"visibility must be one of {', '.join(VISIBILITIES)}")
    return visibility


def ks_stub(
    endpoint: str,
    service_id: Optional[str],
    *,
    api_key: str = "",
    user_key: Optional[str] = None,
    timeout: float = 30,
    verify: bool = True,
    async_: bool = False,
) -> Any:
    """Shared KS transport factory: service-id always, Bearer only if given."""
    need("service_id", service_id)
    cls = AsyncHttpStub if async_ else HttpStub
    return cls(endpoint, api_key, service_id or "", timeout=timeout, verify=verify, user_key=user_key, require_api_key=False)


def flat_graph_options(graph: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Validate wiki /search graph-expansion options (hop int 0..5,
    decay 0..1, minScore >= 0) and flatten to the top-level body fields
    the server reads (hop/decay/minScore)."""
    if not graph:
        return {}
    out: Dict[str, Any] = {}
    if graph.get("hop") is not None:
        hop = graph["hop"]
        if not isinstance(hop, int) or isinstance(hop, bool) or not 0 <= hop <= 5:
            raise ParamError("search hop must be an integer in 0..5")
        out["hop"] = hop
    if graph.get("decay") is not None:
        decay = graph["decay"]
        if not isinstance(decay, (int, float)) or isinstance(decay, bool) or not 0 <= decay <= 1:
            raise ParamError("search decay must be a number in 0..1")
        out["decay"] = decay
    if graph.get("minScore") is not None:
        score = graph["minScore"]
        if not isinstance(score, (int, float)) or isinstance(score, bool) or score < 0:
            raise ParamError("search minScore must be a non-negative number")
        out["minScore"] = score
    return out
