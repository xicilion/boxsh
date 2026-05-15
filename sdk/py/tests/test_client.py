from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from boxsh_py import BoxshClientError, EditOperation

from .common import make_client


class BoxshClientToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = TemporaryDirectory(prefix="boxsh-py-sdk-")
        self.tmp = Path(self.tempdir.name)
        self.client = make_client()

    def tearDown(self) -> None:
        self.client.close()
        self.tempdir.cleanup()

    def test_exec_returns_stdout(self) -> None:
        result = self.client.exec("echo hello")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.stdout, "hello\n")

    def test_exec_non_zero_exit_does_not_raise(self) -> None:
        result = self.client.exec("exit 42")
        self.assertEqual(result.exit_code, 42)

    def test_exec_returns_stderr_on_failure(self) -> None:
        result = self.client.exec("cat /nonexistent/boxsh-test-file")
        self.assertEqual(result.exit_code, 1)
        self.assertTrue(result.stderr)

    def test_read_and_write_roundtrip(self) -> None:
        target = self.tmp / "sample.txt"
        self.client.write(target, "line1\nline2\n")
        result = self.client.read(target)
        self.assertEqual(result.encoding, "text")
        self.assertEqual(result.content, "line1\nline2\n")
        self.assertEqual(result.line_count, 2)

    def test_read_returns_binary_metadata(self) -> None:
        target = self.tmp / "sample.bin"
        target.write_bytes(bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]))
        result = self.client.read(target)
        self.assertEqual(result.encoding, "metadata")
        self.assertEqual(result.size, 10)

    def test_read_supports_offset_and_limit(self) -> None:
        target = self.tmp / "lines.txt"
        target.write_text("a\nb\nc\nd\ne\n", encoding="utf-8")
        result = self.client.read(target, offset=2, limit=2)
        self.assertEqual(result.content, "b\nc\n")

    def test_read_returns_empty_file(self) -> None:
        target = self.tmp / "empty.txt"
        target.write_text("", encoding="utf-8")
        result = self.client.read(target)
        self.assertEqual(result.encoding, "text")
        self.assertEqual(result.content, "")

    def test_write_overwrites_existing_file(self) -> None:
        target = self.tmp / "overwrite.txt"
        target.write_text("original\n", encoding="utf-8")
        self.client.write(target, "updated\n")
        self.assertEqual(target.read_text(encoding="utf-8"), "updated\n")

    def test_edit_accepts_tuple_operations(self) -> None:
        target = self.tmp / "edit.txt"
        target.write_text("hello world\n", encoding="utf-8")
        result = self.client.edit(target, [("world", "earth")])
        self.assertIn("+hello earth", result.diff)
        self.assertEqual(target.read_text(encoding="utf-8"), "hello earth\n")

    def test_edit_accepts_dataclass_operations(self) -> None:
        target = self.tmp / "edit-dataclass.txt"
        target.write_text("hello world\n", encoding="utf-8")
        result = self.client.edit(target, [EditOperation(old_text="hello", new_text="goodbye")])
        self.assertIn("+goodbye world", result.diff)

    def test_edit_missing_file_raises(self) -> None:
        with self.assertRaises(BoxshClientError):
            self.client.edit(self.tmp / "missing-edit.txt", [("x", "y")])

    def test_edit_old_text_not_found_raises(self) -> None:
        target = self.tmp / "edit-not-found.txt"
        target.write_text("hello\n", encoding="utf-8")
        with self.assertRaises(BoxshClientError):
            self.client.edit(target, [("goodbye", "hi")])

    def test_missing_read_raises(self) -> None:
        with self.assertRaises(BoxshClientError):
            self.client.read(self.tmp / "missing.txt")