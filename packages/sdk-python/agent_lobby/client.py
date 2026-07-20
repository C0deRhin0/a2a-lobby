from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib import request, parse
import json
import uuid


@dataclass
class LocalSessionMapping:
    local_session_id: str
    lobby_id: str
    task_id: str
    mcp_session_id: str | None = None
    last_event_cursor: str | None = None


class AgentLobbyClient:
    def __init__(self, base_url: str, bearer_token: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.bearer_token = bearer_token
        self.sessions: dict[str, LocalSessionMapping] = {}

    def map_local_session(self, local_session_id: str, lobby_id: str) -> LocalSessionMapping:
        mapping = LocalSessionMapping(local_session_id=local_session_id, lobby_id=lobby_id, task_id=lobby_id)
        self.sessions[local_session_id] = mapping
        return mapping

    def a2a(self, method: str, params: dict[str, Any] | None = None) -> Any:
        payload = self._post("/a2a", {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": method, "params": params or {}})
        if "error" in payload:
            raise RuntimeError(f"{payload['error']['code']}: {payload['error']['message']}")
        return payload["result"]

    def mcp_tool(self, name: str, arguments: dict[str, Any], local_session_id: str = "default") -> Any:
        mapping = self.sessions.get(local_session_id) or self.map_local_session(local_session_id, str(arguments.get("lobbyId", "unmapped")))
        payload = self._post("/mcp", {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": "tools/call", "params": {"name": name, "arguments": arguments}}, {"mcp-session-id": mapping.mcp_session_id} if mapping.mcp_session_id else None)
        if "error" in payload:
            raise RuntimeError(f"{payload['error']['code']}: {payload['error']['message']}")
        return payload["result"]["structuredContent"]

    def catch_up_events(self, local_session_id: str) -> list[dict[str, Any]]:
        mapping = self.sessions[local_session_id]
        cursor = parse.quote(mapping.last_event_cursor or "0")
        payload = self._get(f"/v1/lobbies/{mapping.lobby_id}/events?from={cursor}")
        mapping.last_event_cursor = payload.get("reconnect", {}).get("cursor", mapping.last_event_cursor)
        return payload.get("events", [])

    def _headers(self, extra: dict[str, str | None] | None = None) -> dict[str, str]:
        headers = {"content-type": "application/json"}
        if self.bearer_token:
            headers["authorization"] = f"Bearer {self.bearer_token}"
        for key, value in (extra or {}).items():
            if value:
                headers[key] = value
        return headers

    def _post(self, path: str, body: dict[str, Any], extra_headers: dict[str, str | None] | None = None) -> Any:
        req = request.Request(f"{self.base_url}{path}", data=json.dumps(body).encode(), headers=self._headers(extra_headers), method="POST")
        with request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode())

    def _get(self, path: str) -> Any:
        req = request.Request(f"{self.base_url}{path}", headers=self._headers(), method="GET")
        with request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode())
