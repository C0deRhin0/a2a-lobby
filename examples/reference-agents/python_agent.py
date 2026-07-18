#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import pathlib
import sys
import urllib.request


BASE_URL = os.environ["AGENT_LOBBY_BASE_URL"].rstrip("/")
TOKEN = os.environ["AGENT_LOBBY_TOKEN"]
STORE_PATH = pathlib.Path(os.environ["AGENT_LOBBY_SESSION_STORE"])
HANDOFF_PATH = pathlib.Path(os.environ["AGENT_LOBBY_HANDOFF"])
STAGE = os.environ.get("AGENT_LOBBY_STAGE", "counterparty-join")


def main() -> None:
    store = read_json(STORE_PATH, {"sessions": {}})
    handoff = read_json(HANDOFF_PATH, {})

    if STAGE == "counterparty-join":
        card = get("/.well-known/agent-card.json")
        lobby_id = handoff["lobbyId"]
        joined = post(f"/v1/lobbies/{lobby_id}/join", {"pairingCode": handoff["pairingCode"]})
        store["sessions"]["counterparty"] = {"localSessionId": "python-reference", "lobbyId": lobby_id, "taskId": lobby_id, "lastEventCursor": "0", "discoveredAgentCard": card["url"]}
        write_json(STORE_PATH, store)
        print(json.dumps({"stage": STAGE, "lobbyId": joined["id"]}))
    elif STAGE == "counterparty-ack-decide":
        session = store["sessions"]["counterparty"]
        lobby_id = session["lobbyId"]
        events = get(f"/v1/lobbies/{lobby_id}/events?from={session.get('lastEventCursor', '0')}")
        session["lastEventCursor"] = events.get("reconnect", {}).get("cursor", session.get("lastEventCursor"))
        ack = post(f"/v1/lobbies/{lobby_id}/messages/{handoff['messageId']}/acknowledgements", {"sequence": handoff["messageSequence"]})
        activation = post(f"/v1/lobbies/{lobby_id}/approval-proposals/{handoff['approvalId']}/activation", {})
        activated, activation_headers = post_with_headers("/activate", {"deviceCode": activation["deviceCode"]})
        cookie = header_value(activation_headers, "set-cookie")
        if not cookie:
            raise RuntimeError("activation did not return an approval session cookie")
        decision = post("/activate/approval/decision", {"decision": os.environ.get("HUMAN_DECISION", "approved")}, {"cookie": cookie, "x-csrf-token": activated["csrfToken"], "idempotency-key": f"python-approval-{handoff['approvalId']}"})
        handoff["counterpartyAck"] = ack
        handoff["humanDecision"] = decision
        write_json(STORE_PATH, store)
        write_json(HANDOFF_PATH, handoff)
        print(json.dumps({"stage": STAGE, "acknowledged": ack["acknowledgedAt"] is not None, "decision": decision["state"]}))
    elif STAGE == "counterparty-approve-agreement":
        lobby_id = handoff["lobbyId"]
        approval = post(f"/v1/lobbies/{lobby_id}/agreements/{handoff['agreementId']}/approvals", {"version": handoff["agreementVersion"], "canonicalHash": handoff["canonicalHash"]})
        handoff["counterpartyAgreementApproval"] = approval
        write_json(HANDOFF_PATH, handoff)
        print(json.dumps({"stage": STAGE, "fullyApproved": approval["fullyApproved"]}))
    else:
        raise RuntimeError(f"unknown AGENT_LOBBY_STAGE {STAGE}")


def headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    return {"content-type": "application/json", "authorization": f"Bearer {TOKEN}", **(extra or {})}


def get(path: str) -> dict:
    req = urllib.request.Request(f"{BASE_URL}{path}", headers=headers(), method="GET")
    return open_json(req)


def post(path: str, body: dict, extra_headers: dict[str, str] | None = None) -> dict:
    req = urllib.request.Request(f"{BASE_URL}{path}", data=json.dumps(body).encode(), headers=headers(extra_headers), method="POST")
    return open_json(req)


def post_with_headers(path: str, body: dict) -> tuple[dict, dict[str, str]]:
    req = urllib.request.Request(f"{BASE_URL}{path}", data=json.dumps(body).encode(), headers=headers(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode()), dict(response.headers.items())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()
        raise RuntimeError(f"{req.method} {req.full_url} failed {exc.code}: {detail}") from exc


def header_value(headers: dict[str, str], name: str) -> str | None:
    normalized_name = name.lower()
    return next((value for key, value in headers.items() if key.lower() == normalized_name), None)


def open_json(req: urllib.request.Request) -> dict:
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()
        raise RuntimeError(f"{req.method} {req.full_url} failed {exc.code}: {detail}") from exc


def read_json(path: pathlib.Path, fallback: dict) -> dict:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return fallback


def write_json(path: pathlib.Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
