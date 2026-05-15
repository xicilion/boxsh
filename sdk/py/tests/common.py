from __future__ import annotations

from pathlib import Path
import os

from boxsh_py import BoxshClient


ROOT = Path(__file__).resolve().parents[3]
BOXSH = os.environ.get("BOXSH", str(ROOT / "build" / "boxsh"))
UUID_RE = (
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def make_client(**kwargs):
    return BoxshClient(boxsh_path=BOXSH, workers=1, **kwargs)