// Building, loading and persisting the per-workspace file index, plus the
// include/exclude-dir maintenance commands.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as readline from 'readline';
import readdirp = require('readdirp');
import { log, logv, logw, loge } from './logger';
import { getSearchDatabaseFile, getTrigramIndexCacheFile, getWorkspaceFolders } from './paths';
import { IndexedFile, makeIndexedFile } from './indexedFile';
import {
    TrigramIndex, buildTrigramIndex, serializeTrigramIndex, deserializeTrigramIndex, hashPaths,
} from './trigramIndex';
import {
    ExcludeRules, DirExcludeState, loadExcludeDirEntries, saveExcludeDirEntries,
    resolveExcludeRules, loadExcludedFileTypes, isExcludedDir, isExcludedFile,
    checkDirExcludedState, addExcludeDirEntries, removeExcludeDirEntries,
} from './settings';

export { IndexedFile, makeIndexedFile } from './indexedFile';

const HEADLINE = "# Auto generated, please don't modify it directly\n"
    + "# You might want to add it into your project's .gitignore\n";

const fileListMap: Map<string, IndexedFile[]> = new Map();
const trigramIndexMap: Map<string, TrigramIndex> = new Map();

function setFileList(workspaceFolder: string, fileList: IndexedFile[]) {
    fileListMap.set(workspaceFolder, fileList);
    console.time("filepicker_loadOrBuildTrigramIndex");
    const index = loadOrBuildTrigramIndex(workspaceFolder, fileList);
    trigramIndexMap.set(workspaceFolder, index);
    console.timeEnd("filepicker_loadOrBuildTrigramIndex");
    log("trigram index: " + index.postings.size + " unique trigrams over "
        + index.fileCount + " files");
}

// Reuses the on-disk index cache when it matches the current file list
// (checked via a hash), otherwise rebuilds and rewrites the cache. Saves the
// ~600ms full rebuild on large projects at every extension host startup.
function loadOrBuildTrigramIndex(workspaceFolder: string, fileList: IndexedFile[]): TrigramIndex {
    const cacheFile = getTrigramIndexCacheFile(workspaceFolder);
    const listHash = hashPaths(fileList.map(f => f.path));
    if (fs.existsSync(cacheFile)) {
        try {
            const cached = deserializeTrigramIndex(fs.readFileSync(cacheFile), listHash);
            if (cached) {
                log("loaded trigram index from cache " + cacheFile);
                return cached;
            }
            log("trigram index cache is stale, rebuilding");
        } catch (err) {
            logw("failed to read trigram index cache: " + err);
        }
    }
    const index = buildTrigramIndex(fileList);
    try {
        fs.writeFileSync(cacheFile, serializeTrigramIndex(index, listHash));
        log("wrote trigram index cache " + cacheFile);
    } catch (err) {
        logw("failed to write trigram index cache: " + err);
    }
    return index;
}

export function getTrigramIndex(workspaceFolder: string): TrigramIndex | undefined {
    return trigramIndexMap.get(workspaceFolder);
}

export async function getFileListOfWorkspaceFolder(workspaceFolder: string): Promise<IndexedFile[]> {
    await loadSearchDatabaseAsync();
    return fileListMap.get(workspaceFolder) || [];
}

let loadPromise: Promise<void> | null = null;

// One shot operation: loads the database of every workspace folder exactly once.
export function loadSearchDatabaseAsync(): Promise<void> {
    if (!loadPromise) {
        loadPromise = loadAllWorkspaces().catch((err) => {
            // allow a retry on the next call
            loadPromise = null;
            throw err;
        });
    }
    return loadPromise;
}

async function loadAllWorkspaces() {
    console.time("filepicker_loadSearchDatabase");
    await Promise.all(getWorkspaceFolders().map(workspaceFolder => {
        const fileSet = readFileListFromCompileDb(workspaceFolder);
        const databaseFile = getSearchDatabaseFile(workspaceFolder);
        return readDbFileLines(databaseFile).then(lines => {
            for (const line of lines) {
                fileSet.add(line);
            }
            log("loaded " + fileSet.size + " files for " + workspaceFolder
                + (lines.length > 0 ? " (db: " + databaseFile + ")" : " (no db)"));
            setFileList(workspaceFolder, pathsToIndexedFiles(fileSet));
        });
    }));
    console.timeEnd("filepicker_loadSearchDatabase");
}

// Reads a '#'-commented, one-path-per-line database file.
function readDbFileLines(databaseFile: string): Promise<string[]> {
    return new Promise((resolve) => {
        if (!fs.existsSync(databaseFile)) {
            resolve([]);
            return;
        }
        const lines: string[] = [];
        const readInterface = readline.createInterface({
            input: fs.createReadStream(databaseFile),
        });
        readInterface.on('line', (line: string) => {
            if (line.length > 0 && !line.startsWith('#')) {
                lines.push(line);
            }
        });
        readInterface.on('close', () => resolve(lines));
    });
}

function pathsToIndexedFiles(paths: Iterable<string>): IndexedFile[] {
    const result: IndexedFile[] = [];
    for (const p of paths) {
        result.push(makeIndexedFile(p));
    }
    return result;
}

// Atomically rewrites the file list database of one workspace folder.
function persistFileList(workspaceFolder: string) {
    const fileList = fileListMap.get(workspaceFolder) || [];
    const dbFile = getSearchDatabaseFile(workspaceFolder);
    const tmpFile = dbFile + ".new";
    fs.writeFileSync(tmpFile, HEADLINE + fileList.map(f => f.path + "\n").join(""));
    fs.renameSync(tmpFile, dbFile);
    log("search database file for workspace folder " + workspaceFolder + " was updated");
}

export type ProgressReporter = (indexedCount: number) => void;

/**
 * Walks the tree under root and returns the deduplicated absolute paths of all
 * indexable files (hidden files/dirs, excluded dirs and file types skipped).
 */
function scanFolder(root: string, rules: ExcludeRules, excludeFileTypes: Set<string>,
    onFile?: ProgressReporter): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const results = new Set<string>();
        const emit = (absPath: string) => {
            if (results.has(absPath)) return;
            results.add(absPath);
            if (onFile) {
                onFile(results.size);
            }
        };
        // A compile_commands.json at the root is an extra source of file paths.
        readFileListFromCompileDb(root, rules, excludeFileTypes, emit);
        readdirp(root, {
            // Follow symlinks
            lstat: true,
            alwaysStat: true,
            fileFilter: (entry: any) => !isExcludedFile(entry.basename, excludeFileTypes),
            directoryFilter: (entry: any) => !isExcludedDir(entry.fullPath, entry.basename, rules),
        }).on('data', (entry: any) => emit(entry.fullPath))
            .on('warn', (error: any) => logw('' + error))
            .on('error', (error: any) => loge('' + error))
            .on('end', () => resolve(Array.from(results)));
    });
}

export async function buildSearchDatabase(onProgress?: ProgressReporter) {
    const excludeFileTypes = loadExcludedFileTypes();
    console.time("filepicker#buildSearchDatabase");
    for (const workspaceFolder of getWorkspaceFolders()) {
        const rules = loadExcludeRules(workspaceFolder);
        log("begin build search database for " + workspaceFolder);
        const found = await scanFolder(workspaceFolder, rules, excludeFileTypes, onProgress);
        setFileList(workspaceFolder, pathsToIndexedFiles(found));
        persistFileList(workspaceFolder);
        log("found " + found.length + " files under " + workspaceFolder);
    }
    console.timeEnd("filepicker#buildSearchDatabase");
}

function loadExcludeRules(workspaceFolder: string): ExcludeRules {
    return resolveExcludeRules(loadExcludeDirEntries(), workspaceFolder);
}

/** The workspace folder containing absPath, or undefined when outside. */
function workspaceFolderOf(absPath: string): string | undefined {
    const fromApi = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absPath));
    if (fromApi) {
        return fromApi.uri.fsPath;
    }
    for (const ws of getWorkspaceFolders()) {
        if (absPath === ws || absPath.startsWith(ws + path.sep)) {
            return ws;
        }
    }
    return undefined;
}

/**
 * Excludes directories: drops their files from the in-memory index, persists
 * the updated database and remembers the exclusion in the settings.
 */
export async function addExcludeDirs(dirs: string[], onProgress?: ProgressReporter) {
    const entries = loadExcludeDirEntries();
    const newDirs: string[] = [];
    // Sort so top level dirs come first; sub-dirs of a newly excluded dir are
    // then redundant and get skipped.
    for (const dir of dirs.slice().sort((a, b) => a.length - b.length)) {
        const workspaceFolder = workspaceFolderOf(dir);
        if (!workspaceFolder) {
            log("#addExcludeDirs, illegal dir: " + dir + " not in workspace");
            continue;
        }
        const rules = resolveExcludeRules(entries, workspaceFolder);
        if (checkDirExcludedState(dir, rules, workspaceFolder).state !== DirExcludeState.NotExcluded) {
            continue;
        }
        if (newDirs.some(p => dir === p || dir.startsWith(p + path.sep))) {
            continue;
        }
        newDirs.push(dir);
    }
    if (newDirs.length === 0) {
        log("#addExcludeDirs, nothing new to exclude");
        vscode.window.showInformationMessage("Already excluded: " + dirs.join(", "));
        return;
    }

    let newEntries = entries;
    for (const dir of newDirs) {
        newEntries = addExcludeDirEntries(newEntries, [dir], workspaceFolderOf(dir)!);
    }
    await saveExcludeDirEntries(newEntries);

    await loadSearchDatabaseAsync();
    const dirtyWorkspaces = new Set<string>();
    for (const dir of newDirs) {
        const workspaceFolder = workspaceFolderOf(dir)!;
        const fileList = fileListMap.get(workspaceFolder);
        if (!fileList) continue;
        setFileList(workspaceFolder,
            fileList.filter(f => f.path !== dir && !f.path.startsWith(dir + path.sep)));
        dirtyWorkspaces.add(workspaceFolder);
    }
    dirtyWorkspaces.forEach(persistFileList);
    log("#addExcludeDirs, just excluded " + newDirs.join(", "));
}

/**
 * Un-excludes directories: re-scans them and merges the found files back into
 * the index and database.
 */
export async function cancelExcludeDirs(dirs: string[], onProgress?: ProgressReporter) {
    let entries = loadExcludeDirEntries();
    const dirsToScan: string[] = [];
    const excludedAncestors: string[] = [];
    for (const dir of dirs.slice().sort((a, b) => a.length - b.length)) {
        const workspaceFolder = workspaceFolderOf(dir);
        if (!workspaceFolder) {
            log("#cancelExcludeDirs, illegal dir: " + dir + " not in workspace");
            continue;
        }
        const rules = resolveExcludeRules(entries, workspaceFolder);
        const check = checkDirExcludedState(dir, rules, workspaceFolder);
        switch (check.state) {
            case DirExcludeState.ExactlyExcluded:
                entries = removeExcludeDirEntries(entries, [dir], workspaceFolder);
                dirsToScan.push(dir);
                break;
            case DirExcludeState.ParentExcluded:
                excludedAncestors.push(
                    check.excludedAncestor!.replace(workspaceFolder, "${workspace}"));
                break;
            case DirExcludeState.NotExcluded:
                break;
        }
    }
    if (excludedAncestors.length > 0) {
        vscode.window.showInformationMessage(
            "Please un-exclude the parent directories firstly:\n" + excludedAncestors.join("\n"));
    }
    if (dirsToScan.length === 0) {
        log("#cancelExcludeDirs, nothing canceled");
        return;
    }

    await saveExcludeDirEntries(entries);
    await loadSearchDatabaseAsync();
    const excludeFileTypes = loadExcludedFileTypes();
    for (const dir of dirsToScan) {
        const workspaceFolder = workspaceFolderOf(dir)!;
        const rules = loadExcludeRules(workspaceFolder);
        const found = await scanFolder(dir, rules, excludeFileTypes, onProgress);
        const fileList = fileListMap.get(workspaceFolder) || [];
        const known = new Set(fileList.map(f => f.path));
        const merged = fileList.slice();
        for (const p of found) {
            if (!known.has(p)) {
                known.add(p);
                merged.push(makeIndexedFile(p));
            }
        }
        setFileList(workspaceFolder, merged);
        persistFileList(workspaceFolder);
    }
    log("#cancelExcludeDirs, just indexed " + dirsToScan.join(", "));
}

// ---------------------------------------------------------------------------
// compile_commands.json support: it is an extra source of file paths, used in
// addition to the directory walk (and when no database was built yet).
// ---------------------------------------------------------------------------

function readFileListFromCompileDb(root: string, rules?: ExcludeRules,
    excludeFileTypes?: Set<string>, emit?: (absPath: string) => void): Set<string> {
    const fileSet = new Set<string>();
    const collect = emit || ((p: string) => fileSet.add(p));
    parseCompileDb(root, (fullPath) => {
        const basename = path.basename(fullPath);
        const parentDir = path.dirname(fullPath);
        if (rules && isExcludedDir(parentDir, path.basename(parentDir), rules)) {
            logv("excluded " + fullPath);
            return;
        }
        if (excludeFileTypes && isExcludedFile(basename, excludeFileTypes)) {
            logv("skip excluded file type: " + fullPath);
            return;
        }
        collect(fullPath);
    });
    return fileSet;
}

function parseCompileDb(dir: string, onFile: (fullPath: string) => void) {
    const compileDb = path.join(dir, "compile_commands.json");
    if (!fs.existsSync(compileDb)) {
        logv("compile db not exist: " + compileDb);
        return;
    }
    logv("Loading from " + compileDb);
    try {
        const contents = fs.readFileSync(compileDb, 'utf8');
        const compileCommands = JSON.parse(contents);
        for (const compileCommand of compileCommands) {
            const parentDir: string = compileCommand["directory"];
            const file: string = compileCommand["file"];
            const fullPath = file.startsWith("/") ? file : path.join(parentDir, file);
            if (!parentDir.startsWith(dir)) {
                logv("excluded " + fullPath);
                continue;
            }
            if (path.basename(fullPath).charAt(0) === '.') {
                continue; // hidden files are never indexed
            }
            onFile(fullPath);
        }
    } catch (error) {
        logv("Contents of compile db is not valid: " + compileDb);
    }
}
