from __future__ import annotations

import unittest
import uuid

from boxsh_py import BoxshClientError

from .common import UUID_RE, make_client


class BoxshTerminalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = make_client()

    def tearDown(self) -> None:
        self.client.close()

    def test_terminal_lifecycle(self) -> None:
        session = self.client.run_in_terminal("bash")
        self.assertTrue(session.id)
        self.assertRegex(session.id, UUID_RE)

        result = self.client.send_to_terminal(session.id, "echo hello\n")
        self.assertIsInstance(result.output, str)
        self.assertIsInstance(result.exited, bool)
        self.assertIn(result.exit_code, (None, 0))

        sessions = self.client.list_terminals()
        self.assertTrue(any(item.id == session.id for item in sessions))

        final_output = self.client.kill_terminal(session.id)
        self.assertIsInstance(final_output, str)

    def test_run_in_terminal_shape(self) -> None:
        session = self.client.run_in_terminal("echo sdk_test_123")
        if not session.exited:
            self.client.kill_terminal(session.id)
        self.assertRegex(session.id, UUID_RE)
        self.assertIsInstance(session.output, str)
        self.assertIsInstance(session.exited, bool)
        self.assertTrue(isinstance(session.exit_code, int) if session.exited else session.exit_code is None)

    def test_list_terminals_contains_live_session(self) -> None:
        session = self.client.run_in_terminal("bash")
        try:
            sessions = self.client.list_terminals()
        finally:
            self.client.kill_terminal(session.id)
        found = next(item for item in sessions if item.id == session.id)
        self.assertEqual(found.command, "bash")
        self.assertTrue(found.alive)
        self.assertIsInstance(found.cols, int)
        self.assertIsInstance(found.rows, int)

    def test_get_terminal_output_for_live_session(self) -> None:
        session = self.client.run_in_terminal("bash")
        try:
            result = self.client.get_terminal_output(session.id)
        finally:
            self.client.kill_terminal(session.id)
        self.assertIsInstance(result.output, str)
        self.assertFalse(result.exited)
        self.assertIsNone(result.exit_code)

    def test_get_terminal_output_for_exited_process(self) -> None:
        session = self.client.run_in_terminal("true")
        try:
            result = None
            for _ in range(10):
                result = self.client.get_terminal_output(session.id)
                if result.exited:
                    break
        finally:
            self.client.kill_terminal(session.id)
        assert result is not None
        self.assertTrue(result.exited)
        self.assertEqual(result.exit_code, 0)

    def test_unknown_terminal_raises(self) -> None:
        unknown = str(uuid.UUID("00000000-0000-4000-8000-000000000000"))
        with self.assertRaises(BoxshClientError):
            self.client.get_terminal_output(unknown)

    def test_kill_unknown_terminal_raises(self) -> None:
        unknown = str(uuid.UUID("00000000-0000-4000-8000-000000000000"))
        with self.assertRaises(BoxshClientError):
            self.client.kill_terminal(unknown)

    def test_send_unknown_terminal_raises(self) -> None:
        unknown = str(uuid.UUID("00000000-0000-4000-8000-000000000000"))
        with self.assertRaises(BoxshClientError):
            self.client.send_to_terminal(unknown, "echo x\n")

    def test_killed_session_removed_from_list(self) -> None:
        session = self.client.run_in_terminal("bash")
        self.client.kill_terminal(session.id)
        sessions = self.client.list_terminals()
        self.assertFalse(any(item.id == session.id for item in sessions))

    def test_multiple_concurrent_sessions(self) -> None:
        first = self.client.run_in_terminal("bash")
        second = self.client.run_in_terminal("bash")
        try:
            sessions = self.client.list_terminals()
        finally:
            self.client.kill_terminal(first.id)
            self.client.kill_terminal(second.id)
        ids = [item.id for item in sessions]
        self.assertIn(first.id, ids)
        self.assertIn(second.id, ids)

    def test_terminal_snapshot_has_no_ansi_escapes(self) -> None:
        session = self.client.run_in_terminal("bash")
        try:
            output = session.output
        finally:
            self.client.kill_terminal(session.id)
        self.assertNotRegex(output, "\\x1b\\[")