from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from boxsh_py import BoxshClientError, EditOperation

from .common import ROOT, make_client


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

    def test_read_returns_binary_error(self) -> None:
        target = self.tmp / "sample.bin"
        target.write_bytes(bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]))
        with self.assertRaises(BoxshClientError) as ctx:
            self.client.read(target)
        # Truncated PNG header: detected as an image, not readable as text.
        self.assertEqual(ctx.exception.code, "E_NOT_IMAGE")
        self.assertEqual(ctx.exception.detail["size"], 10)

    def test_view_image_returns_payload_and_metadata(self) -> None:
        target = ROOT / "tests" / "fixture" / "fixture.png"
        result = self.client.view_image(target)
        self.assertEqual(result.mime_type, "image/png")
        self.assertEqual((result.width, result.height), (200, 133))
        self.assertFalse(result.was_resized)
        self.assertFalse(result.animated)
        self.assertTrue(result.data)
        self.assertEqual(result.text, "[Image: image/png, 200x133]")

    def test_view_image_rejects_non_image(self) -> None:
        target = self.tmp / "not-an-image.txt"
        target.write_text("hello\n", encoding="utf-8")
        with self.assertRaises(BoxshClientError) as ctx:
            self.client.view_image(target)
        self.assertEqual(ctx.exception.code, "E_NOT_IMAGE")

    def test_read_reports_paging_information(self) -> None:
        target = self.tmp / "page.txt"
        target.write_text("".join(f"l{i}\n" for i in range(1, 21)), encoding="utf-8")
        result = self.client.read(target, offset=1, limit=5)
        self.assertTrue(result.truncated)
        self.assertEqual(result.total_lines, 20)
        self.assertEqual(result.next_offset, 6)

    def test_read_supports_offset_and_limit(self) -> None:
        target = self.tmp / "lines.txt"
        target.write_text("a\nb\nc\nd\ne\n", encoding="utf-8")
        result = self.client.read(target, offset=2, limit=2)
        # body plus the paging hint appended by the server
        self.assertTrue(result.content.startswith("b\nc\n"))
        self.assertIn("continue with offset=4", result.content)

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
        self.client.edit(target, [("world", "earth")])
        self.assertEqual(target.read_text(encoding="utf-8"), "hello earth\n")

    def test_edit_accepts_dataclass_operations(self) -> None:
        target = self.tmp / "edit-dataclass.txt"
        target.write_text("hello world\n", encoding="utf-8")
        self.client.edit(target, [EditOperation(old_text="hello", new_text="goodbye")])
        self.assertEqual(target.read_text(encoding="utf-8"), "goodbye world\n")

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