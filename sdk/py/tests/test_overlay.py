from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from boxsh_py import CowBind, ReadOnlyBind, ReadWriteBind, format_changes, get_changes

from .common import make_client


class BoxshChangesTests(unittest.TestCase):
    def test_get_changes_formats_overlay_delta(self) -> None:
        with TemporaryDirectory(prefix="boxsh-py-upper-") as upper_raw, TemporaryDirectory(prefix="boxsh-py-base-") as base_raw:
            upper = Path(upper_raw)
            base = Path(base_raw)

            (base / "src").mkdir(parents=True)
            (upper / "src").mkdir(parents=True)

            (base / "src" / "keep.txt").write_text("base\n", encoding="utf-8")
            (upper / "src" / "keep.txt").write_text("changed\n", encoding="utf-8")
            (upper / "src" / "new.txt").write_text("new\n", encoding="utf-8")
            (upper / ".wh.deleted.txt").write_text("", encoding="utf-8")

            changes = get_changes(upper=str(upper), base=str(base))
            self.assertEqual(
                [(change.path, change.type) for change in changes],
                [("deleted.txt", "deleted"), ("src/keep.txt", "modified"), ("src/new.txt", "added")],
            )
            self.assertEqual(format_changes(changes), "D\tdeleted.txt\nM\tsrc/keep.txt\nA\tsrc/new.txt\n")


class BoxshOverlayParityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = TemporaryDirectory(prefix="boxsh-py-overlay-parity-")
        self.tmp = Path(self.tempdir.name)
        self.base = self.tmp / "project"
        self.base.mkdir()
        (self.base / "src").mkdir()
        (self.base / "docs").mkdir()
        (self.base / "README.md").write_text("# Project\n", encoding="utf-8")
        (self.base / "src" / "index.ts").write_text('console.log("hello")\n', encoding="utf-8")
        (self.base / "src" / "utils.ts").write_text(
            "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n",
            encoding="utf-8",
        )
        (self.base / "docs" / "guide.md").write_text("# Guide\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def make_client(self, label: str):
        client_dir = self.tmp / label
        upper = client_dir / "dst"
        upper.mkdir(parents=True)
        client = make_client(sandbox=True, binds=[CowBind(src=self.base, dst=upper)])
        return client, upper, upper

    def test_basic_shell_commands_in_overlay(self) -> None:
        client, upper, cwd = self.make_client("shell-basic")
        try:
            echo = client.exec('echo "hello session"', cwd=cwd)
            listing = client.exec("ls", cwd=cwd)
            cat = client.exec("cat README.md", cwd=cwd)
            grep = client.exec('grep -n "export" src/utils.ts', cwd=cwd)
            wc = client.exec("wc -l src/utils.ts", cwd=cwd)
            head = client.exec("head -n 1 src/utils.ts", cwd=cwd)
            pipeline = client.exec('cat src/utils.ts | grep "export" | wc -l', cwd=cwd)
            found = client.exec('find src -name "*.ts"', cwd=cwd)
            nested = client.exec("cd src && ls", cwd=cwd)
        finally:
            client.close()

        self.assertEqual(echo.exit_code, 0)
        self.assertIn("hello session", echo.stdout)
        self.assertIn("README.md", listing.stdout)
        self.assertIn("src", listing.stdout)
        self.assertIn("# Project", cat.stdout)
        self.assertEqual(grep.exit_code, 0)
        self.assertIn("export const x", grep.stdout)
        self.assertEqual(wc.exit_code, 0)
        self.assertIn("3", wc.stdout)
        self.assertEqual(head.exit_code, 0)
        self.assertIn("export const x = 1", head.stdout)
        self.assertEqual(pipeline.stdout.strip(), "3")
        self.assertIn("index.ts", found.stdout)
        self.assertIn("utils.ts", found.stdout)
        self.assertIn("index.ts", nested.stdout)
        self.assertTrue(upper.exists())

    def test_overlay_write_behaviors(self) -> None:
        client, upper, cwd = self.make_client("shell-write")
        try:
            mkdir_result = client.exec("mkdir -p new-dir", cwd=cwd)
            redirect_result = client.exec('echo "redirected content" > output.txt', cwd=cwd)
            client.exec('echo "new data" > created.txt', cwd=cwd)
            read_back = client.exec("cat created.txt", cwd=cwd)
            after_ls = client.exec("ls", cwd=cwd)
            changes = get_changes(upper=str(upper), base=str(self.base))
            client.exec('echo "modified" > README.md', cwd=cwd)
            modified_readme = client.exec("cat README.md", cwd=cwd)
        finally:
            client.close()

        self.assertEqual(mkdir_result.exit_code, 0)
        self.assertTrue((upper / "new-dir").exists())
        self.assertEqual(redirect_result.exit_code, 0)
        self.assertIn("redirected content", (upper / "output.txt").read_text(encoding="utf-8"))
        self.assertFalse((self.base / "output.txt").exists())
        self.assertIn("new data", read_back.stdout)
        self.assertIn("created.txt", after_ls.stdout)
        self.assertIn("README.md", after_ls.stdout)
        self.assertTrue(any(change.path == "created.txt" and change.type == "added" for change in changes))
        self.assertEqual((self.base / "README.md").read_text(encoding="utf-8"), "# Project\n")
        self.assertIn("modified", modified_readme.stdout)

    def test_overlay_isolation_between_clients(self) -> None:
        client_a, upper_a, cwd_a = self.make_client("isolation-a")
        client_b, upper_b, cwd_b = self.make_client("isolation-b")
        try:
            client_a.exec('echo "a data" > a-file.txt', cwd=cwd_a)
            client_b.exec('echo "b data" > b-file.txt', cwd=cwd_b)
            result_a = client_a.exec('cat b-file.txt 2>/dev/null || true', cwd=cwd_a)
            result_b = client_b.exec('cat b-file.txt', cwd=cwd_b)
        finally:
            client_a.close()
            client_b.close()

        self.assertNotIn("b data", result_a.stdout)
        self.assertIn("b data", result_b.stdout)
        self.assertFalse((upper_a / "b-file.txt").exists())
        self.assertFalse((upper_b / "a-file.txt").exists())


class BoxshOverlayTests(unittest.TestCase):
    def test_cow_bind_exposes_changes(self) -> None:
        with TemporaryDirectory(prefix="boxsh-py-overlay-") as tmp_raw:
            tmp = Path(tmp_raw)
            base = tmp / "base"
            dst = tmp / "dst"
            base.mkdir()
            dst.mkdir()
            (base / "README.md").write_text("# Project\n", encoding="utf-8")

            with make_client(sandbox=True, binds=[CowBind(src=base, dst=dst)]) as client:
                result = client.exec("printf 'patched\\n' > README.md", cwd=dst)
                self.assertEqual(result.exit_code, 0)

            changes = get_changes(upper=str(dst), base=str(base))
            self.assertEqual([(change.path, change.type) for change in changes], [("README.md", "modified")])

    def test_read_only_and_read_write_bind_types_format(self) -> None:
        with TemporaryDirectory(prefix="boxsh-py-bind-") as tmp_raw:
            tmp = Path(tmp_raw)
            readonly = tmp / "readonly"
            writable = tmp / "writable"
            readonly.mkdir()
            writable.mkdir()
            (readonly / "ro.txt").write_text("ro\n", encoding="utf-8")

            with make_client(sandbox=True, binds=[ReadOnlyBind(path=readonly), ReadWriteBind(path=writable)]) as client:
                ro = client.exec("cat ro.txt", cwd=readonly)
                wr = client.exec("printf 'wr\\n' > out.txt", cwd=writable)

            self.assertEqual(ro.exit_code, 0)
            self.assertIn("ro", ro.stdout)
            self.assertEqual(wr.exit_code, 0)
            self.assertEqual((writable / "out.txt").read_text(encoding="utf-8"), "wr\n")