// Workspace folder helpers and on-disk layout of the per-workspace databases.
//
// Everything lives under ~/.q_file_picker/<workspace path with separators
// replaced by '@'>/, e.g. file_index.db and recently_files.db.

import * as vscode from 'vscode';
import * as path from 'path';
import { mkdirSync, existsSync } from 'fs';
import { logd } from './logger';

const homedir = require('os').homedir();
export const ConfigDir = path.join(homedir, ".q_file_picker");

const workSpaceToConfigDirMap = new Map<string, string>();

export function getWorkspaceFolders(): string[] {
    return vscode.workspace.workspaceFolders
        ? vscode.workspace.workspaceFolders.map(f => f.uri.fsPath)
        : [process.cwd()];
}

export function getWorkspaceFolder(): string {
    return getWorkspaceFolders()[0];
}

export function getWorkspaceFolderOfRecentFileDatabase(databaseFile: string): string | null {
    for (const [workSpaceFolder, configDir] of workSpaceToConfigDirMap) {
        if (databaseFile.startsWith(configDir)) {
            return workSpaceFolder;
        }
    }
    return null;
}

function getDatabaseDir(workspaceDir: string): string {
    const workdir = workspaceDir ? workspaceDir : getWorkspaceFolder();
    const cached = workSpaceToConfigDirMap.get(workdir);
    if (cached) {
        return cached;
    }
    // replace path separator of unix and windows styles to '@'
    const dir = path.join(ConfigDir, workdir.replace(/[/\\]/g, "@"));
    logd("map workspaceDir " + workdir + " to " + dir);
    if (!existsSync(dir)) {
        if (!existsSync(ConfigDir)) {
            mkdirSync(ConfigDir, { recursive: true });
        }
        mkdirSync(dir);
    }
    workSpaceToConfigDirMap.set(workdir, dir);
    return dir;
}

export function getSearchDatabaseFile(workspaceDir: string): string {
    return path.join(getDatabaseDir(workspaceDir), "file_index.db");
}

export function getTrigramIndexCacheFile(workspaceDir: string): string {
    return path.join(getDatabaseDir(workspaceDir), "trigram_index.cache");
}

export function getRecentlyFilesDatabasePath(workspaceDir: string): string {
    return path.join(getDatabaseDir(workspaceDir), "recently_files.db");
}

export function getRecentlyOpenedFilelistDatabases(): string[] {
    return getWorkspaceFolders().map(workspaceFolder =>
        getRecentlyFilesDatabasePath(workspaceFolder));
}

let unixLike = -1;
export function isUnixLikeSystem(): boolean {
    if (unixLike === -1) {
        unixLike = getWorkspaceFolder().startsWith("/") ? 1 : 0;
    }
    return unixLike === 1;
}
