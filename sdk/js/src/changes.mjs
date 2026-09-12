/**
 * Changes detection: scan the upper directory to extract file modifications
 * relative to the base layer.
 *
 * Detects:
 *   - Added   files (in upper, not in base)
 *   - Modified files (in both layers)
 *   - Deleted  files (whiteout markers in upper)
 *
 * Supports both host-side whiteout format (.wh.<name> files) and
 * kernel overlay whiteout format (char device 0/0), including the reserved
 * `.wh..wh.*` metadata (opaque-dir markers, hardlink index) fuse-overlayfs
 * writes — it is the COW engine used on host mounts that cannot store kernel
 * overlay metadata (macOS/Docker virtiofs).
 */

import fs from 'node:fs';
import path from 'node:path';

const WH_PREFIX = '.wh.';
// Reserved OCI/fuse-overlayfs metadata namespace: `.wh..wh..opq` (opaque
// directory marker) and `.wh..wh.plnk` (hardlink index).  These are never
// user-visible entries — treating them as whiteouts for a file named `.wh.opq`
// / `.wh.plnk` produced phantom deletions on the fuse-overlayfs path (the COW
// engine boxsh falls back to when the kernel overlay cannot store overlay
// metadata, e.g. macOS/Docker virtiofs host mounts).
const WH_META_PREFIX = '.wh..wh.';
const WH_OPAQUE = '.wh..wh..opq';
const MANIFEST_DIR = '.boxsh';
const MANIFEST_SUFFIX = '.manifest';

/**
 * Scan the upper directory and return a list of all changes relative to base.
 *
 * @param {{ upper: string, base: string }} options
 * @returns {Array<{ path: string, type: 'added'|'modified'|'deleted' }>}
 */
export function getChanges(options) {
    const manifest = _readCloneManifest(options.upper);
    if (manifest) {
        return _getCloneSnapshotChanges(options.upper, options.base, manifest);
    }

    const changes = [];
    _scanChanges(options.upper, options.base, '.', changes);
    return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function _getCloneSnapshotChanges(upperRoot, baseRoot, manifestPaths) {
    const changes = [];
    const deletedAncestors = new Set();

    for (const relPath of manifestPaths) {
        if (_hasDeletedAncestor(relPath, deletedAncestors)) continue;
        if (fs.existsSync(path.join(upperRoot, relPath))) continue;
        deletedAncestors.add(relPath);
        changes.push({ path: relPath, type: 'deleted' });
    }

    _scanCloneSnapshotChanges(upperRoot, baseRoot, '.', changes);
    return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * @param {string} upperRoot
 * @param {string} baseRoot
 * @param {string} rel
 * @param {Array<object>} changes
 */
function _scanChanges(upperRoot, baseRoot, rel, changes) {
    const upperDir = path.join(upperRoot, rel);
    if (!fs.existsSync(upperDir) || !fs.statSync(upperDir).isDirectory()) return;

    for (const name of fs.readdirSync(upperDir)) {
        const childRel  = rel === '.' ? name : path.join(rel, name);
        const upperPath = path.join(upperRoot, childRel);

        // fuse-overlayfs metadata (opaque marker, hardlink index): never a
        // change entry of its own.  An opaque marker hides the lower content
        // of this directory, so the lower entries missing from the upper are
        // genuine deletions.
        if (name.startsWith(WH_META_PREFIX)) {
            if (name === WH_OPAQUE) {
                _collectOpaqueDeletions(upperRoot, baseRoot, rel, changes);
            }
            continue;
        }

        // Host-side whiteout (.wh.<name>)
        if (name.startsWith(WH_PREFIX)) {
            const targetName = name.slice(WH_PREFIX.length);
            const targetRel  = rel === '.' ? targetName : path.join(rel, targetName);
            changes.push({ path: targetRel, type: 'deleted' });
            continue;
        }

        // Kernel overlay whiteout (char device 0/0)
        if (_isKernelWhiteout(upperPath)) {
            changes.push({ path: childRel, type: 'deleted' });
            continue;
        }

        const st = fs.statSync(upperPath);

        if (st.isDirectory()) {
            const basePath = path.join(baseRoot, childRel);
            if (!fs.existsSync(basePath)) {
                changes.push({ path: childRel, type: 'added' });
            }
            _scanChanges(upperRoot, baseRoot, childRel, changes);
        } else if (st.isFile()) {
            const basePath = path.join(baseRoot, childRel);
            changes.push({ path: childRel, type: fs.existsSync(basePath) ? 'modified' : 'added' });
        }
    }
}

function _scanCloneSnapshotChanges(upperRoot, baseRoot, rel, changes) {
    const upperDir = path.join(upperRoot, rel);
    if (!fs.existsSync(upperDir) || !fs.statSync(upperDir).isDirectory()) return;

    for (const name of fs.readdirSync(upperDir)) {
        const childRel = rel === '.' ? name : path.join(rel, name);
        const upperPath = path.join(upperRoot, childRel);

        if (name.startsWith(WH_META_PREFIX)) {
            if (name === WH_OPAQUE) {
                _collectOpaqueDeletions(upperRoot, baseRoot, rel, changes);
            }
            continue;
        }

        if (name.startsWith(WH_PREFIX)) {
            const targetName = name.slice(WH_PREFIX.length);
            const targetRel = rel === '.' ? targetName : path.join(rel, targetName);
            changes.push({ path: targetRel, type: 'deleted' });
            continue;
        }

        if (_isKernelWhiteout(upperPath)) {
            changes.push({ path: childRel, type: 'deleted' });
            continue;
        }

        const upperStat = fs.lstatSync(upperPath);
        const basePath = path.join(baseRoot, childRel);

        if (upperStat.isDirectory()) {
            if (!fs.existsSync(basePath)) {
                changes.push({ path: childRel, type: 'added' });
            }
            _scanCloneSnapshotChanges(upperRoot, baseRoot, childRel, changes);
            continue;
        }

        if (!fs.existsSync(basePath)) {
            changes.push({ path: childRel, type: 'added' });
            continue;
        }

        if (_pathsDiffer(upperPath, basePath)) {
            changes.push({ path: childRel, type: 'modified' });
        }
    }
}

/**
 * An opaque directory marker (`.wh..wh..opq`) hides every lower entry of the
 * directory it lives in.  Report the lower entries the upper layer does not
 * contain — neither directly nor as a whiteout — as deleted.
 *
 * @param {string} upperRoot
 * @param {string} baseRoot
 * @param {string} rel   directory holding the marker, relative to the roots
 * @param {Array<object>} changes
 */
function _collectOpaqueDeletions(upperRoot, baseRoot, rel, changes) {
    const upperDir = path.join(upperRoot, rel);
    let lowerNames;
    try {
        lowerNames = fs.readdirSync(path.join(baseRoot, rel));
    } catch {
        return;   // no lower counterpart — nothing is hidden
    }

    for (const lowerName of lowerNames) {
        if (fs.existsSync(path.join(upperDir, lowerName))) continue;
        if (fs.existsSync(path.join(upperDir, WH_PREFIX + lowerName))) continue;
        changes.push({
            path: rel === '.' ? lowerName : path.join(rel, lowerName),
            type: 'deleted',
        });
    }
}

/**
 * Detect kernel overlay whiteout: character device with rdev 0.
 * @param {string} filePath
 * @returns {boolean}
 */
function _isKernelWhiteout(filePath) {
    try {
        const st = fs.lstatSync(filePath);
        return st.isCharacterDevice?.() && st.rdev === 0;
    } catch {
        return false;
    }
}

function _readCloneManifest(upperRoot) {
    const manifestPath = path.join(
        path.dirname(upperRoot),
        MANIFEST_DIR,
        `${path.basename(upperRoot)}${MANIFEST_SUFFIX}`,
    );

    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
        return null;
    }

    return fs.readFileSync(manifestPath, 'utf8')
        .split(/\r?\n/u)
        .filter(Boolean);
}

function _hasDeletedAncestor(relPath, deletedAncestors) {
    let current = path.dirname(relPath);
    while (current && current !== '.') {
        if (deletedAncestors.has(current)) return true;
        current = path.dirname(current);
    }
    return false;
}

function _pathsDiffer(upperPath, basePath) {
    const upperStat = fs.lstatSync(upperPath);
    const baseStat = fs.lstatSync(basePath);

    if (upperStat.isSymbolicLink() || baseStat.isSymbolicLink()) {
        return upperStat.isSymbolicLink() !== baseStat.isSymbolicLink() ||
            fs.readlinkSync(upperPath) !== fs.readlinkSync(basePath);
    }

    if (upperStat.isFile() && baseStat.isFile()) {
        if (upperStat.size !== baseStat.size) return true;
        return !fs.readFileSync(upperPath).equals(fs.readFileSync(basePath));
    }

    return upperStat.isDirectory() !== baseStat.isDirectory();
}

/**
 * Format a list of changes as a human-readable summary.
 *
 * @param {Array<{ path: string, type: 'added'|'modified'|'deleted' }>} changes
 * @returns {string}
 */
export function formatChanges(changes) {
    if (changes.length === 0) return 'No changes detected.\n';
    return changes
        .map(c => `${c.type === 'added' ? 'A' : c.type === 'modified' ? 'M' : 'D'}\t${c.path}`)
        .join('\n') + '\n';
}
