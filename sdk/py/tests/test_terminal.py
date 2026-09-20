from __future__ import annotations

import re
from typing import List, Optional

import unittest
import uuid

from boxsh_py import BoxshClientError, TerminalReadOptions

from .common import UUID_RE, make_client


_ANSI_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]")


def stream_lines(raw: Optional[str]) -> List[str]:
    """Split a raw PTY stream into lines the way a reader would see them.

    The tty writes CRLF and wraps output in escape sequences (bash on Linux
    brackets prompts and output with ESC[?2004h/l), which would otherwise glue
    themselves onto the text and break exact line comparisons.
    """
    text = _ANSI_RE.sub("", raw or "")
    return [line.replace("\r", "") for line in text.split("\n")]

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

class BoxshTerminalOutputModelTests(unittest.TestCase):
    """The lossless stream channel and the wait/exit-code options."""

    def setUp(self) -> None:
        self.client = make_client()

    def tearDown(self) -> None:
        self.client.close()

    def test_wait_for_exit_returns_the_complete_output(self) -> None:
        from boxsh_py import RunInTerminalOptions

        result = self.client.run_in_terminal(
            'seq 1 100 | sed "s/^/N-/"',
            RunInTerminalOptions(wait_for="exit", wait_ms=20000),
        )
        try:
            self.assertTrue(result.exited)
            self.assertEqual(result.exit_code, 0)
            lines = [line for line in stream_lines(result.stream) if line.startswith("N-")]
            self.assertEqual(len(lines), 100)
            self.assertFalse(result.truncated_before)
        finally:
            self.client.kill_terminal(result.id)

    def test_cursor_reads_are_deltas(self) -> None:
        from boxsh_py import TerminalReadOptions

        session = self.client.run_in_terminal("bash")
        try:
            first = self.client.send_to_terminal(
                session.id, "echo FIRST\n", TerminalReadOptions(cursor=0, wait_ms=800)
            )
            self.assertIn("FIRST", first.stream or "")
            self.assertIsNotNone(first.next_cursor)

            idle = self.client.get_terminal_output(
                session.id, TerminalReadOptions(cursor=first.next_cursor, wait_ms=200)
            )
            self.assertEqual(idle.stream, "")

            second = self.client.send_to_terminal(
                session.id, "echo SECOND\n",
                TerminalReadOptions(cursor=first.next_cursor, wait_ms=800),
            )
            self.assertIn("SECOND", second.stream or "")
            self.assertNotIn("FIRST", second.stream or "")
        finally:
            self.client.kill_terminal(session.id)

    def test_capture_status_reports_the_command_exit_code(self) -> None:
        session = self.client.run_in_terminal("bash")
        try:
            ok = self.client.send_to_terminal(session.id, "true\n", capture_status=True, opts=None)
            self.assertEqual(ok.command_exit_code, 0)
            bad = self.client.send_to_terminal(session.id, "false\n", capture_status=True)
            self.assertEqual(bad.command_exit_code, 1)
        finally:
            self.client.kill_terminal(session.id)

    def test_list_terminals_include_exited(self) -> None:
        import time

        session = self.client.run_in_terminal("true")
        time.sleep(0.3)
        visible_ids = [item.id for item in self.client.list_terminals()]
        self.assertNotIn(session.id, visible_ids)
        listed = self.client.list_terminals(include_exited=True)
        found = next((item for item in listed if item.id == session.id), None)
        self.assertIsNotNone(found)
        assert found is not None
        self.assertTrue(found.exited)
        self.assertEqual(found.exit_code, 0)
        self.client.kill_terminal(session.id)


class BoxshTerminalSignalTests(unittest.TestCase):
    """Signals as a first-class primitive (no control bytes needed)."""

    def setUp(self) -> None:
        self.client = make_client()

    def tearDown(self) -> None:
        self.client.close()

    def test_signal_int_abandons_the_command_line(self) -> None:
        import time

        session = self.client.run_in_terminal("bash")
        try:
            time.sleep(0.3)                     # let bash reach its prompt
            self.client.send_to_terminal(session.id, "echo START; sleep 2; echo AFTER\n")
            # Wait until the command is really running instead of sleeping a
            # fixed amount: a signal sent before the shell gets there would be a
            # no-op on a slow machine.
            deadline = time.time() + 8
            while time.time() < deadline:
                seen = self.client.get_terminal_output(session.id, TerminalReadOptions(cursor=0, wait_ms=400))
                if "START" in stream_lines(seen.stream):
                    break
            self.client.send_to_terminal(session.id, signal="INT")
            time.sleep(2.5)                     # past the sleep
            result = self.client.get_terminal_output(session.id, TerminalReadOptions(cursor=0))
            lines = stream_lines(result.stream)
            self.assertIn("START", lines)
            self.assertNotIn("AFTER", lines)
            self.assertFalse(result.exited)
        finally:
            self.client.kill_terminal(session.id)

    def test_unknown_signal_is_rejected(self) -> None:
        session = self.client.run_in_terminal("bash")
        try:
            with self.assertRaises(BoxshClientError):
                self.client.send_to_terminal(session.id, signal="NOPE")
        finally:
            self.client.kill_terminal(session.id)
