from __future__ import annotations

import os
import unittest
from unittest import mock

from boxsh_py import BashExecOptions, create_bash_operations, shell_quote

from .common import BOXSH, ROOT


class BoxshHelperTests(unittest.TestCase):
    def test_shell_quote_escapes_single_quotes(self) -> None:
        self.assertEqual(shell_quote("hello'world"), "'hello'\\''world'")

    def test_create_bash_operations_returns_fallback_when_boxsh_missing(self) -> None:
        class Fallback:
            def exec(self, command, cwd, options=None):
                return "fallback"

        fallback = Fallback()
        with mock.patch.dict(os.environ, {}, clear=True):
            with mock.patch("boxsh_py.client.shutil.which", return_value=None):
                result = create_bash_operations(fallback=fallback)
        self.assertIs(result, fallback)

    def test_create_bash_operations_exec_streams_output(self) -> None:
        ops = create_bash_operations(boxsh_path=BOXSH, sandbox=False)
        chunks = []
        try:
            result = ops.exec("printf 'hello'", cwd=ROOT, options=BashExecOptions(on_data=chunks.append))
        finally:
            ops._client.close()
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(b"".join(chunks), b"hello")