// LRU list of recently opened files, persisted per workspace folder.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as readline from 'readline';
import { log, logw, logv, logd } from './logger';
import { getRecentlyOpenedFilelistDatabases, getWorkspaceFolderOfRecentFileDatabase } from './paths';

const MAX_TRACKED_FILES = 50;
const HEADLINE = "# auto generated file, used to cache recently opened files\n";

const recentlyOpenedFileList: string[] = []; // acts like a LRU cache

// flag to rewrite cache
let recentOpenedFileListChanged = false;
let persistTimer: NodeJS.Timeout | undefined;

export async function getRecentlyOpenedFileList(): Promise<string[]> {
    await loadRecentlyOpenedFileListCache();
    return recentlyOpenedFileList;
}

/** Map of file -> LRU position (0 = most recently opened). */
export async function getRecentFileRanks(): Promise<Map<string, number>> {
    await loadRecentlyOpenedFileListCache();
    const ranks = new Map<string, number>();
    recentlyOpenedFileList.forEach((file, i) => ranks.set(file, i));
    return ranks;
}

export function removeFileFromHistory(file: string) {
    const index = recentlyOpenedFileList.indexOf(file);
    if (index < 0) {
        return;
    }
    logv(file + " was removed from history");
    recentlyOpenedFileList.splice(index, 1);
    recentOpenedFileListChanged = true;
    schedulePersist();
}

export function initRecentFileHistory() {
    vscode.window.onDidChangeActiveTextEditor((editor) => {
        const current = editor || vscode.window.activeTextEditor;
        if (!current) {
            return;
        }
        trackOpenedFile(current.document.uri.fsPath);
    });
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        trackOpenedFile(editor.document.uri.fsPath);
    }
}

function trackOpenedFile(file: string) {
    loadRecentlyOpenedFileListCache().then(() => {
        fs.stat(file, (err) => {
            if (err) {
                log(file + " not exist on disk");
                return;
            }
            if (updateRecentlyOpenedFilesList(file)) {
                recentOpenedFileListChanged = true;
                schedulePersist();
            }
        });
    });
}

function updateRecentlyOpenedFilesList(file: string): boolean {
    const index = recentlyOpenedFileList.indexOf(file);
    // the param file was already at the head of this LRU
    if (index === 0) {
        return false;
    }
    logv(file + " was opened");
    if (index > 0) {
        recentlyOpenedFileList.splice(index, 1);
    }
    recentlyOpenedFileList.unshift(file);
    if (recentlyOpenedFileList.length > MAX_TRACKED_FILES) {
        recentlyOpenedFileList.splice(MAX_TRACKED_FILES,
            recentlyOpenedFileList.length - MAX_TRACKED_FILES);
    }
    return true;
}

function schedulePersist() {
    if (persistTimer !== undefined) {
        clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
        persistTimer = undefined;
        persistRecentlyOpenedFileList();
    }, 1000);
}

function persistRecentlyOpenedFileList() {
    if (!recentOpenedFileListChanged) return;
    recentOpenedFileListChanged = false;
    getRecentlyOpenedFilelistDatabases().forEach(dbFile => {
        const workspaceFolder = getWorkspaceFolderOfRecentFileDatabase(dbFile);
        if (!workspaceFolder) {
            logw("can't find workspace folder for recently opened file list database: " + dbFile);
            return;
        }
        const lines = recentlyOpenedFileList
            .filter(file => file.startsWith(workspaceFolder))
            .map(file => file + "\n")
            .join("");
        fs.writeFileSync(dbFile, HEADLINE + lines);
    });
    log("changes of recently opened file list have been wrote to disk");
}

let fileListLoadedPromise: Promise<void> | undefined;

function loadRecentlyOpenedFileListCache(): Promise<void> {
    if (fileListLoadedPromise) return fileListLoadedPromise;
    fileListLoadedPromise = Promise.all(getRecentlyOpenedFilelistDatabases().map(dbFile => {
        return new Promise<void>((resolve) => {
            if (!fs.existsSync(dbFile)) {
                log("recently opened files db not exist");
                resolve();
                return;
            }
            logd("load recently opened file list db");
            const readInterface = readline.createInterface({
                input: fs.createReadStream(dbFile),
            });
            readInterface.on('line', (line: string) => {
                if (line.length > 0 && !line.startsWith('#')) {
                    updateRecentlyOpenedFilesList(line);
                }
            });
            readInterface.on('close', () => {
                log("recently opened file list loaded");
                resolve();
            });
        });
    })).then(() => undefined);
    return fileListLoadedPromise;
}
