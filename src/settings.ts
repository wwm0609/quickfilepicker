// Reading and writing the extension's settings (excluded dirs / file types).
//
// The excludeDirs setting is a ':'-separated list whose entries are either:
//   - "${workspace}/some/dir" or an absolute path  -> matched by full path
//   - a bare name like "out"                       -> matched by directory name
// Bare names matter: the always-excluded defaults (".git", ...) are names and
// must not be resolved against any directory.

import * as vscode from 'vscode';
import * as path from 'path';

export const DEFAULT_EXCLUDE_DIRS = [".git", ".repo", ".vscode", ".qfile_picker"];

export interface ExcludeRules {
    /** bare directory names, excluded wherever they appear */
    dirNames: Set<string>;
    /** absolute directory paths; a dir is excluded when it is one of them or inside one */
    dirPaths: string[];
}

export const enum DirExcludeState {
    NotExcluded = 0,
    ExactlyExcluded = 1,
    ParentExcluded = 2,
}

export interface DirExcludeCheck {
    state: DirExcludeState;
    /** set when state is ParentExcluded: the already-excluded ancestor */
    excludedAncestor?: string;
}

function toConfigEntry(absDir: string, workspaceDir: string): string {
    if (absDir === workspaceDir) {
        return "${workspace}";
    }
    if (absDir.startsWith(workspaceDir + path.sep)) {
        return "${workspace}" + absDir.substring(workspaceDir.length);
    }
    return absDir;
}

/** Raw ':'-separated excludeDirs entries from the config, defaults not included. */
export function loadExcludeDirEntries(): string[] {
    const config = vscode.workspace.getConfiguration("FilePicker");
    const raw: string = config.get("excludeDirs", "");
    return raw.split(":").filter(entry => entry.length > 0);
}

export function saveExcludeDirEntries(entries: string[]) {
    const config = vscode.workspace.getConfiguration("FilePicker");
    return config.update("excludeDirs", entries.join(":"));
}

/** File extensions (lowercased, with dot) that should not be indexed. */
export function loadExcludedFileTypes(): Set<string> {
    const config = vscode.workspace.getConfiguration("FilePicker");
    const raw: string = config.get("excludeFileTypes", "");
    const result = new Set<string>();
    for (let entry of raw.split(":")) {
        entry = entry.trim().toLowerCase();
        if (entry.length === 0) continue;
        result.add(entry.startsWith(".") ? entry : "." + entry);
    }
    return result;
}

function classifyEntry(entry: string, workspaceDir: string): { name?: string, absPath?: string } {
    if (entry.startsWith("${workspace}")) {
        return { absPath: path.resolve(entry.replace("${workspace}", workspaceDir)) };
    }
    if (entry.indexOf('/') >= 0 || entry.indexOf('\\') >= 0) {
        return { absPath: path.resolve(entry) };
    }
    return { name: entry };
}

/** Resolves raw config entries (plus the defaults) into matchable rules. */
export function resolveExcludeRules(entries: string[], workspaceDir: string): ExcludeRules {
    const dirNames = new Set<string>(DEFAULT_EXCLUDE_DIRS);
    const dirPaths: string[] = [];
    for (const entry of entries.concat(DEFAULT_EXCLUDE_DIRS)) {
        const { name, absPath } = classifyEntry(entry, workspaceDir);
        if (name !== undefined) {
            dirNames.add(name);
        } else if (absPath !== undefined) {
            dirPaths.push(absPath);
        }
    }
    return { dirNames, dirPaths };
}

export function loadExcludeRules(workspaceDir: string): ExcludeRules {
    return resolveExcludeRules(loadExcludeDirEntries(), workspaceDir);
}

/** Whether a directory should be skipped while walking the tree. */
export function isExcludedDir(fullPath: string, basename: string, rules: ExcludeRules): boolean {
    // hidden folders are never indexed
    if (basename.charAt(0) === '.') {
        return true;
    }
    if (rules.dirNames.has(basename)) {
        return true;
    }
    for (const p of rules.dirPaths) {
        if (fullPath === p || fullPath.startsWith(p + path.sep)) {
            return true;
        }
    }
    return false;
}

/** Whether a file should be skipped while walking the tree. */
export function isExcludedFile(basename: string, excludeFileTypes: Set<string>): boolean {
    if (basename.charAt(0) === '.') {
        return true;
    }
    if (excludeFileTypes.size === 0) {
        return false;
    }
    return excludeFileTypes.has(path.extname(basename).toLowerCase());
}

/**
 * Checks whether dir itself or one of its ancestors (up to, but not including,
 * the workspace root) is already excluded.
 */
export function checkDirExcludedState(dir: string, rules: ExcludeRules, workspaceDir: string): DirExcludeCheck {
    let cur = dir;
    while (cur !== workspaceDir) {
        const parent = path.dirname(cur);
        if (parent === cur) {
            break; // reached filesystem root without hitting the workspace dir
        }
        const isExact = rules.dirPaths.indexOf(cur) >= 0
            || rules.dirNames.has(path.basename(cur));
        if (isExact) {
            return cur === dir
                ? { state: DirExcludeState.ExactlyExcluded }
                : { state: DirExcludeState.ParentExcluded, excludedAncestor: cur };
        }
        cur = parent;
    }
    return { state: DirExcludeState.NotExcluded };
}

/** Appends abs dirs to the config entries (in ${workspace} form), deduping. */
export function addExcludeDirEntries(entries: string[], dirs: string[], workspaceDir: string): string[] {
    const result = entries.slice();
    for (const dir of dirs) {
        const entry = toConfigEntry(dir, workspaceDir);
        if (result.indexOf(entry) < 0) {
            result.push(entry);
        }
    }
    return result;
}

/** Removes the config entries that resolve to any of the given dirs. */
export function removeExcludeDirEntries(entries: string[], dirs: string[], workspaceDir: string): string[] {
    return entries.filter(entry => {
        const { name, absPath } = classifyEntry(entry, workspaceDir);
        if (absPath !== undefined) {
            return dirs.indexOf(absPath) < 0;
        }
        return name === undefined || dirs.every(dir => path.basename(dir) !== name);
    });
}
