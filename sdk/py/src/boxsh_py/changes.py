from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from stat import S_ISCHR
from typing import List, Literal
import os

WhiteoutType = Literal["added", "modified", "deleted"]
_WHITEOUT_PREFIX = ".wh."


@dataclass(frozen=True)
class Change:
    path: str
    type: WhiteoutType


def get_changes(*, upper: str, base: str) -> List[Change]:
    changes: List[Change] = []
    _scan_changes(Path(upper), Path(base), Path("."), changes)
    return sorted(changes, key=lambda change: change.path)


def _scan_changes(upper_root: Path, base_root: Path, rel: Path, changes: List[Change]) -> None:
    upper_dir = upper_root / rel
    if not upper_dir.exists() or not upper_dir.is_dir():
        return

    for entry in upper_dir.iterdir():
        child_rel = Path(entry.name) if rel == Path(".") else rel / entry.name
        upper_path = upper_root / child_rel

        if entry.name.startswith(_WHITEOUT_PREFIX):
            target_name = entry.name[len(_WHITEOUT_PREFIX):]
            target_rel = Path(target_name) if rel == Path(".") else rel / target_name
            changes.append(Change(path=target_rel.as_posix(), type="deleted"))
            continue

        if _is_kernel_whiteout(upper_path):
            changes.append(Change(path=child_rel.as_posix(), type="deleted"))
            continue

        if upper_path.is_dir():
            base_path = base_root / child_rel
            if not base_path.exists():
                changes.append(Change(path=child_rel.as_posix(), type="added"))
            _scan_changes(upper_root, base_root, child_rel, changes)
            continue

        if upper_path.is_file():
            base_path = base_root / child_rel
            changes.append(
                Change(path=child_rel.as_posix(), type="modified" if base_path.exists() else "added")
            )


def _is_kernel_whiteout(file_path: Path) -> bool:
    try:
        stat_result = os.lstat(file_path)
    except OSError:
        return False
    return S_ISCHR(stat_result.st_mode) and os.major(stat_result.st_rdev) == 0 and os.minor(stat_result.st_rdev) == 0


def format_changes(changes: List[Change]) -> str:
    if not changes:
        return "No changes detected.\n"
    marker = {"added": "A", "modified": "M", "deleted": "D"}
    return "".join(f"{marker[change.type]}\t{change.path}\n" for change in changes)