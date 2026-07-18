import os
import unittest

os.environ.setdefault("AGENT_LOBBY_BASE_URL", "http://127.0.0.1")
os.environ.setdefault("AGENT_LOBBY_TOKEN", "test-token")
os.environ.setdefault("AGENT_LOBBY_SESSION_STORE", "/tmp/python-agent-test-store.json")
os.environ.setdefault("AGENT_LOBBY_HANDOFF", "/tmp/python-agent-test-handoff.json")

from python_agent import header_value


class ApprovalActivationHeadersTest(unittest.TestCase):
    def test_reads_lowercase_set_cookie_from_activation_response(self) -> None:
        self.assertEqual(
            header_value({"set-cookie": "al_approval_session=session; HttpOnly"}, "set-cookie"),
            "al_approval_session=session; HttpOnly",
        )


if __name__ == "__main__":
    unittest.main()
