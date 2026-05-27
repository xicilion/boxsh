from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from stat import S_ISCHR
from typing import List, Literal
import filecmp
import os

WhiteoutType = Literal["added", "modified", "deleted"]
_WHITEOUT_PREFIX = ".wh."
_MANIFEST_SUFFIX = ".manifest"


@dataclass(frozen=True)
class Change:
    path: str
    type: WhiteoutType


def get_changes(*, upper: str, base: str) -> List[Change]:
    manifest = _read_clone_manifest(Path(upper))
    if manifest is not None:
        return _get_clone_snapshot_changes(Path(upper), Path(base), manifest)

    changes: List[Change] = []
    _scan_changes(Path(upper), Path(base), Path("."), changes)
    return sorted(changes, key=lambda change: change.path)


def _get_clone_snapshot_changes(upper_root: Path, base_root: Path, manifest_paths: List[str]) -> List[Change]:
    changes: List[Change] = []
    deleted_ancestors: set[str] = set()

    for rel_path in manifest_paths:
        if _has_deleted_ancestor(rel_path, deleted_ancestors):
            continue
        if (upper_root / rel_path).exists():
            continue
        deleted_ancestors.add(rel_path)
        changes.append(Change(path=rel_path, type="deleted"))

    _scan_clone_snapshot_changes(upper_root, base_root, Path("."), changes)
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


def _scan_clone_snapshot_changes(upper_root: Path, base_root: Path, rel: Path, changes: List[Change]) -> None:
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

        base_path = base_root / child_rel

        if upper_path.is_dir():
            if not base_path.exists():
                changes.append(Change(path=child_rel.as_posix(), type="added"))
            _scan_clone_snapshot_changes(upper_root, base_root, child_rel, changes)
            continue

        if not base_path.exists():
            changes.append(Change(path=child_rel.as_posix(), type="added"))
            continue

        if _paths_differ(upper_path, base_path):
            changes.append(Change(path=child_rel.as_posix(), type="modified"))


def _is_kernel_whiteout(file_path: Path) -> bool:
    try:
        stat_result = os.lstat(file_path)
    except OSError:
        return False
    return S_ISCHR(stat_result.st_mode) and os.major(stat_result.st_rdev) == 0 and os.minor(stat_result.st_rdev) == 0


def _read_clone_manifest(upper_root: Path) -> List[str] | None:
    manifest_path = upper_root.parent / ".boxsh" / f"{upper_root.name}{_MANIFEST_SUFFIX}"
    if not manifest_path.exists() or not manifest_path.is_file():
        return None
    return [line for line in manifest_path.read_text(encoding="utf-8").splitlines() if line]


def _has_deleted_ancestor(rel_path: str, deleted_ancestors: set[str]) -> bool:
    current = Path(rel_path).parent.as_posix()
    while current and current != ".":
        if current in deleted_ancestors:
            return True
        current = Path(current).parent.as_posix()
    return False


def _paths_differ(upper_path: Path, base_path: Path) -> bool:
    if upper_path.is_symlink() or base_path.is_symlink():
        return upper_path.is_symlink() != base_path.is_symlink() or os.readlink(upper_path) != os.readlink(base_path)

    if upper_path.is_file() and base_path.is_file():
        return not filecmp.cmp(upper_path, base_path, shallow=False)

    return upper_path.is_dir() != base_path.is_dir()


def format_changes(changes: List[Change]) -> str:
    if not changes:
        return "No changes detected.\n"
    marker = {"added": "A", "modified": "M", "deleted": "D"}
    return "".join(f"{marker[change.type]}\t{change.path}\n" for change in changes)