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
 * kernel overlay whiteout format (char device 0/0).
 */

import fs from 'node:fs';
import path from 'node:path';

const WH_PREFIX = '.wh.';

/**
 * Scan the upper directory and return a list of all changes relative to base.
 *
 * @param {{ upper: string, base: string }} options
 * @returns {Array<{ path: string, type: 'added'|'modified'|'deleted' }>}
 */
export function getChanges(options) {
    const changes = [];
    _scanChanges(options.upper, options.base, '.', changes);
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
