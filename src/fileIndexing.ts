import fs = require('fs');
import { getWorkspaceFolder, getWorkspaceFolders, log, logv, getSearchDatabaseFile, logw, loge, buildShortName } from "./constants";
import readline = require('readline');
import * as path from 'path';
import * as vscode from 'vscode';
import readdirp = require('readdirp');

export interface IndexedFile {
    path: string;
    basenameLower: string;
    shortName: string;
}

export function makeIndexedFile(absPath: string): IndexedFile {
    const basename = path.basename(absPath);
    return {
        path: absPath,
        basenameLower: basename.toLowerCase(),
        shortName: buildShortName(basename),
    };
}

const fileListMap: Map<string, IndexedFile[]> = new Map();

const HEADLINE = "# Auto generated, please don't modify it directly\n"
    + "# You might want to add it into your project's .gitignore\n";

function _getFileListOfWorkspaceFolder(workspaceFolder: string): IndexedFile[] {
    var fileList = fileListMap.get(workspaceFolder);
    if (!fileList) {
        fileList = [];
        fileListMap.set(workspaceFolder, fileList);
    }
    return fileList;
}

function _updateFileListForWorkspace(workspaceFolder: string, fileList: IndexedFile[]) {
    fileListMap.set(workspaceFolder, fileList);
    setTrigramIndex(workspaceFolder, fileList);
}

export async function getFileListOfWorkspaceFolder(workspaceFolder: string) {
    await loadSearchDatabaseAsync();
    return _getFileListOfWorkspaceFolder(workspaceFolder);
}

export async function loadSearchDatabaseAsync() {
    // we have already loaded the cache file
    if (fileListMap.size > 0) {
        return;
    }
    // one shot operarion
    await Promise.all(getWorkspaceFolders().map(workspaceFolder => {
        return new Promise((resolve, reject) => {
            var fileSet: Set<string> = readFileListFromCompileDb(workspaceFolder)
            var databaseFile = getSearchDatabaseFile(workspaceFolder);
            if (!fs.existsSync(databaseFile)) {
                log("search datababse not exist, compiledb entry count=" + fileSet.size);
                _updateFileListForWorkspace(workspaceFolder, pathsToIndexedFiles(fileSet));
                resolve(null);
                return
            }

            console.time("filepicker_loadSearchDatabase");
            log("loading search datababse at " + databaseFile)
            const readInterface = readline.createInterface({
                input: fs.createReadStream(databaseFile),
                output: process.stdout,
            });
            readInterface.on('line', function (line: string) {
                fileSet.add(line);
            });
            readInterface.on('close', () => {
                log("just loaded " + databaseFile);
                _updateFileListForWorkspace(workspaceFolder, pathsToIndexedFiles(fileSet));
                console.timeEnd("filepicker_loadSearchDatabase");
                resolve(null);
                return;
            });
        });
    }));
}

function pathsToIndexedFiles(paths: Iterable<string>): IndexedFile[] {
    const result: IndexedFile[] = [];
    for (const p of paths) {
        result.push(makeIndexedFile(p));
    }
    return result;
}

// Trigram inverted index over basenameLower of every IndexedFile in a workspace.
// Maps each 3-char substring to the sorted list of file indices whose basename
// contains it. Pattern lookup intersects the posting lists for the pattern's
// trigrams to obtain a small candidate set, avoiding a full scan.
//
// Stored as Uint32Array (4B/entry) instead of number[] (~50B/entry in V8) to
// keep memory bounded on large workspaces (~15-20MB for 310k files).
//
// Companion shortNameByFirstChar index: trigrams are over basenameLower, so
// they would miss CamelCase shortName matches like "ams" -> ActivityManagerService.
// For each non-empty shortName, we bucket (shortName, fileIdx) by its first
// character so a shortName.startsWith(pattern) lookup can scan only one bucket.
export interface TrigramIndex {
    postings: Map<string, Uint32Array>;
    shortNameByFirstChar: Map<string, Array<[string, number]>>;
    fileCount: number;
}

const trigramIndexMap: Map<string, TrigramIndex> = new Map();

const TRIGRAM_LEN = 3;

function buildTrigramIndex(fileList: IndexedFile[]): TrigramIndex {
    const builder: Map<string, number[]> = new Map();
    const seenInThisFile = new Set<string>();
    const shortNameByFirstChar: Map<string, Array<[string, number]>> = new Map();
    for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        const bn = f.basenameLower;
        if (bn.length >= TRIGRAM_LEN) {
            seenInThisFile.clear();
            const last = bn.length - TRIGRAM_LEN;
            for (let j = 0; j <= last; j++) {
                const gram = bn.substr(j, TRIGRAM_LEN);
                if (seenInThisFile.has(gram)) continue;
                seenInThisFile.add(gram);
                let list = builder.get(gram);
                if (!list) {
                    list = [];
                    builder.set(gram, list);
                }
                // i is monotonically increasing, so list stays sorted.
                list.push(i);
            }
        }
        if (f.shortName.length > 0) {
            const c = f.shortName.charAt(0);
            let bucket = shortNameByFirstChar.get(c);
            if (!bucket) {
                bucket = [];
                shortNameByFirstChar.set(c, bucket);
            }
            bucket.push([f.shortName, i]);
        }
    }
    const postings: Map<string, Uint32Array> = new Map();
    builder.forEach((list, gram) => {
        postings.set(gram, Uint32Array.from(list));
    });
    return { postings, shortNameByFirstChar, fileCount: fileList.length };
}

function setTrigramIndex(workspaceFolder: string, fileList: IndexedFile[]) {
    console.time("filepicker_buildTrigramIndex");
    const index = buildTrigramIndex(fileList);
    trigramIndexMap.set(workspaceFolder, index);
    console.timeEnd("filepicker_buildTrigramIndex");
    log("built trigram index: " + index.postings.size + " unique trigrams over "
        + index.fileCount + " files");
}

// Intersect two sorted Uint32Array posting lists into a new Uint32Array.
function intersectSorted(a: Uint32Array, b: Uint32Array): Uint32Array {
    const out = new Uint32Array(Math.min(a.length, b.length));
    let ai = 0, bi = 0, oi = 0;
    while (ai < a.length && bi < b.length) {
        const av = a[ai], bv = b[bi];
        if (av === bv) {
            out[oi++] = av;
            ai++; bi++;
        } else if (av < bv) {
            ai++;
        } else {
            bi++;
        }
    }
    return out.slice(0, oi);
}

// Union two sorted Uint32Array posting lists into a new Uint32Array, deduping.
function unionSorted(a: Uint32Array, b: Uint32Array): Uint32Array {
    const out = new Uint32Array(a.length + b.length);
    let ai = 0, bi = 0, oi = 0;
    while (ai < a.length && bi < b.length) {
        const av = a[ai], bv = b[bi];
        if (av === bv) {
            out[oi++] = av;
            ai++; bi++;
        } else if (av < bv) {
            out[oi++] = av;
            ai++;
        } else {
            out[oi++] = bv;
            bi++;
        }
    }
    while (ai < a.length) out[oi++] = a[ai++];
    while (bi < b.length) out[oi++] = b[bi++];
    return out.slice(0, oi);
}

// Walks the shortName bucket for the pattern's first character and returns the
// sorted file indices whose shortName starts with the pattern.
function lookupShortNameCandidates(index: TrigramIndex, patternLower: string): Uint32Array {
    const bucket = index.shortNameByFirstChar.get(patternLower.charAt(0));
    if (!bucket) return new Uint32Array(0);
    const hits: number[] = [];
    for (let i = 0; i < bucket.length; i++) {
        if (bucket[i][0].startsWith(patternLower)) hits.push(bucket[i][1]);
    }
    if (hits.length === 0) return new Uint32Array(0);
    // Bucket order matches insertion order (i is monotonically increasing per
    // file in buildTrigramIndex), so hits are already sorted.
    return Uint32Array.from(hits);
}

// Returns null when the caller should fall back to a full scan (no index built
// yet, or pattern shorter than a single trigram). Returns an empty array when
// the index proves there cannot be any matches.
export function lookupTrigramCandidates(workspaceFolder: string, patternLower: string): Uint32Array | null {
    if (patternLower.length < TRIGRAM_LEN) return null;
    const index = trigramIndexMap.get(workspaceFolder);
    if (!index) return null;
    const last = patternLower.length - TRIGRAM_LEN;
    const lists: Uint32Array[] = [];
    for (let j = 0; j <= last; j++) {
        const gram = patternLower.substr(j, TRIGRAM_LEN);
        const list = index.postings.get(gram);
        if (!list || list.length === 0) {
            // No basename contains this trigram, but a shortName match might
            // still exist (e.g. "ams" -> ActivityManagerService).
            lists.length = 0;
            break;
        }
        lists.push(list);
    }
    let basenameCandidates: Uint32Array;
    if (lists.length === 0) {
        basenameCandidates = new Uint32Array(0);
    } else if (lists.length === 1) {
        basenameCandidates = lists[0];
    } else {
        // Intersect shortest first to keep the running set small.
        lists.sort((x, y) => x.length - y.length);
        let acc = lists[0];
        for (let k = 1; k < lists.length && acc.length > 0; k++) {
            acc = intersectSorted(acc, lists[k]);
        }
        basenameCandidates = acc;
    }
    const shortNameCandidates = lookupShortNameCandidates(index, patternLower);
    if (shortNameCandidates.length === 0) return basenameCandidates;
    if (basenameCandidates.length === 0) return shortNameCandidates;
    return unionSorted(basenameCandidates, shortNameCandidates);
}

const property_key_exclude_dirs = "excludeDirs";

function isDirectoryInsideWorkspace(dir: string, workspaceDirs: string[]) {
    for (var workspaceDir of workspaceDirs) {
        if (dir.startsWith(workspaceDir)) {
            return true;
        }
    }
    return false;
}

export async function addExcludeDirs(dirs: string[]) {
    const currentExcludeDirs = loadExcludedDirs();
    const workspaceDirs = getWorkspaceFolders();
    // sort the array, make top level directies appear in the front of the array,
    // thus if a top level dir was added into excluded dirs, no  sub-directies of it
    // would be appened to the exclude list. 
    var newExcludeDirs = dirs.sort((a, b) => a.length - b.length).filter((dir: string) => {
        // assert
        if (!isDirectoryInsideWorkspace(dir, workspaceDirs)) {
            log("#updateIncludeAndExcludeDirs, illegal dir: " + dir + " not in workspace");
            return false;
        }
        // check if it is already excluded
        if (checkDirExcludedState(dir, currentExcludeDirs).state == Not_Excluded_Yet) {
            currentExcludeDirs.push(dir);
            return true;
        }
        return false;
    });

    if (newExcludeDirs.length == 0) {
        log("already excluded: " + dirs);
        vscode.window.showInformationMessage("Already excluded: " + dirs)
        return;
    }

    saveWorkspaceConfiguration(currentExcludeDirs);

    var workspaceFoldersNeedToReScanned = [];
    for (var workspaceDir of workspaceDirs) {
        if (!fs.existsSync(getSearchDatabaseFile(getWorkspaceFolder()))) {
            log("search datababse for workspace folder" + workspaceDir);
            vscode.window.showInformationMessage("Search database for workspace folder: " + workspaceDir
                + " not exist, don't forget to build it later");
            continue;
        }
        workspaceFoldersNeedToReScanned.push(workspaceDir);
    }
    if (workspaceFoldersNeedToReScanned.length == 0) {
        log("no available search databases");
        return;
    }

    await loadSearchDatabaseAsync();

    const myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    myStatusBarItem.text = `exclude|0`;
    myStatusBarItem.show();
    const dirtyWorkspaces = new Set<string>();
    // update files list: remove excluded files
    await Promise.all(newExcludeDirs.map((dir) => {
        var workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir));
        const workspaceDir = workspaceFolder ? workspaceFolder.uri.fsPath : "";
        if (workspaceDir.length == 0) return;
        const fileList = _getFileListOfWorkspaceFolder(workspaceDir);
        var index = fileList.length;
        var deleteCount = 0;
        while (--index > 0) {
            if (fileList[index].path.startsWith(dir)) {
                deleteCount++;
                continue;
            }

            if (deleteCount > 0) fileList.splice(index + 1, deleteCount);
            deleteCount = 0;
        }
        dirtyWorkspaces.add(workspaceDir);
    }));
    // file indices shifted after splice, so rebuild the trigram index for each
    // affected workspace.
    dirtyWorkspaces.forEach(ws => setTrigramIndex(ws, _getFileListOfWorkspaceFolder(ws)));
    myStatusBarItem.hide();
    log("#addExcludeDirs, just excluded " + newExcludeDirs);
    persistFileListToDisk();
}

export async function cancelExcludeDirs(cancelExcludeDirs: string[]) {
    var workspaceDirs = getWorkspaceFolders();
    const currentExcludeDirs = loadExcludedDirs();
    const newDirs: string[] = []
    cancelExcludeDirs.sort((a, b) => a.length - b.length).forEach((dir: string) => {
        // assert
        if (!isDirectoryInsideWorkspace(dir, workspaceDirs)) {
            log("#updateIncludeAndExcludeDirs, illegal dir: " + dir + " not in workspace");
            return;
        }
        // check if it is already excluded
        var state = checkDirExcludedState(dir, currentExcludeDirs);
        var message = "";
        switch (state.state) {
            case Not_Excluded_Yet: {
                break;
            }
            case ExactlyExcluded: {
                removeElementFromArray(currentExcludeDirs, dir);
                newDirs.push(dir);
                break;
            }
            case ParentDirExcluded: {
                message += "    " + state.extra.replace(workspaceDir, "${workspace}") + "\n";
                break;
            }
        }
        if (message.charAt(message.length - 1) == '\n') {
            message = "Please un-exclude the parent directies firstly:\n"
                + message.substr(0, message.length - 1);
            vscode.window.showInformationMessage(message);
        }
    });

    if (newDirs.length == 0) {
        log("#cancelExcludeDirs, nothing canceled");
        return;
    }

    saveWorkspaceConfiguration(currentExcludeDirs);


    var workspaceFoldersNeedToIndexed = [];
    for (var workspaceDir of workspaceDirs) {
        if (!fs.existsSync(getSearchDatabaseFile(getWorkspaceFolder()))) {
            log("search datababse for workspace folder" + workspaceDir);
            vscode.window.showInformationMessage("Search database for workspace folder: " + workspaceDir
                + " not exist, don't forget to build it later");
            continue;
        }
        workspaceFoldersNeedToIndexed.push(workspaceDir);
    }
    if (workspaceFoldersNeedToIndexed.length == 0) {
        log("no available search databases");
        return;
    }


    await loadSearchDatabaseAsync();

    const myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    myStatusBarItem.text = `incremental indexing...`;
    myStatusBarItem.show();
    var count = 0

    // update search datababse: index files in those dirs we just unexcluded
    await Promise.all(newDirs.map((dir) => {
        var workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir));
        const workspaceDir = workspaceFolder ? workspaceFolder.uri.fsPath : "";
        const fileList = _getFileListOfWorkspaceFolder(workspaceDir);
        const fileSet: Set<string> = new Set(fileList.map(f => f.path));
        walkFileTree(dir, currentExcludeDirs, (abs_path: string) => {
            // The end
            if (abs_path == null) {
                _updateFileListForWorkspace(workspaceDir, pathsToIndexedFiles(fileSet))
                return;
            }
            var file = abs_path;
            if (!fileSet.has(file)) {
                logv("found " + file);
                fileSet.add(file)
                myStatusBarItem.text = `incremental indexing|` + (++count);
            }
        });
    }));
    myStatusBarItem.hide();
    log("#cancelExcludeDirs, just indexed " + newDirs);

    persistFileListToDisk();
}

function loadExcludedFileTypes() {
    let config = vscode.workspace.getConfiguration("FilePicker");
    const excludeFileTypes = config.get("excludeFileTypes", "");
    log("excludeFileTypes: " + excludeFileTypes)
    return excludeFileTypes.split(":");
}

// we'll won't indexing files under these directoies anyway
const default_exclude_dirs = [".git", ".repo", ".vscode", ".qfile_picker"];
function loadExcludedDirs() {
    const workspaceDir = getWorkspaceFolder();
    let config = vscode.workspace.getConfiguration("FilePicker");
    const excludeDirsConfig = config.get("excludeDirs", "");
    // exclude dirs that user specified
    var excludeDirs = new Set<String>(excludeDirsConfig.split(":").concat(default_exclude_dirs)
        .filter((elem: string) => {
            // remove duplicated items and empty string
            return elem.length > 0;
        }));
    var results: string[] = [];
    excludeDirs.forEach((item) => {
        results.push(path.resolve(item.replace("${workspace}", workspaceDir)));
    });
    // exclude all dirs whose names are like the follow pattern
    return results.sort();
}


function saveWorkspaceConfiguration(excludeDirs: string[]) {
    let config = vscode.workspace.getConfiguration("FilePicker");
    var excludeDirsConfig = "";
    const workspaceDir = getWorkspaceFolder();
    for (var dir of excludeDirs) {
        if (default_exclude_dirs.indexOf(dir) >= 0) {
            // don't wirte defaults
            continue;
        }
        excludeDirsConfig += ":" + dir.replace(workspaceDir, "${workspace}");
    }
    if (excludeDirsConfig.length > 1) {
        excludeDirsConfig = excludeDirsConfig.substring(1);
        config.update(property_key_exclude_dirs, excludeDirsConfig);
    }
}


class FileExcludeState {
    extra = "";
    state = 0;
    constructor(state: number, extra: string) {
        this.state = state;
        this.extra = extra;
    }
}

const Not_Excluded_Yet = 0;
const ExactlyExcluded = 1;
const ParentDirExcluded = 2;
function checkDirExcludedState(newExcludeDir: string, excludedDirs: string[]) {
    var workspaceDir = getWorkspaceFolder();
    var dir = newExcludeDir;
    while (dir != workspaceDir) {
        if (excludedDirs.indexOf(dir) >= 0) {
            if (dir == newExcludeDir) {
                return new FileExcludeState(ExactlyExcluded, "");;
            }
            return new FileExcludeState(ParentDirExcluded, dir);;
        }
        dir = path.dirname(dir);
    }
    return new FileExcludeState(Not_Excluded_Yet, "");
}

function removeElementFromArray(targetArray: string[], elem: string) {
    var index = targetArray.indexOf(elem);
    if (index >= 0) {
        targetArray.splice(index, 1);
    }
}


// async
function persistFileListToDisk() {
    fileListMap.forEach((fileList, workspaceFolder) => {
        const pathOfDb = getSearchDatabaseFile(workspaceFolder);
        const pathOfNewDb = pathOfDb + ".new";
        const stream = fs.createWriteStream(pathOfNewDb);
        stream.write(HEADLINE);
        fileList.forEach((item: IndexedFile) => {
            stream.write(item.path + "\n");
        });
        stream.end();
        fs.rename(pathOfNewDb, pathOfDb, () => {
            log("search database file for workspace foler " + workspaceFolder + " was updated");
        });
    });
}

export async function buildSearchDatabase() {
    var excludeDirs = loadExcludedDirs();
    var excludeFileTypes = new Set<string>(loadExcludedFileTypes())
    console.time("filepicker#buildSearchDatabase");
    for (var workspaceFolder of getWorkspaceFolders()) {
        log("begin build search database for " + workspaceFolder + ", exclude dirs: " + excludeDirs);
        const cacheFile = getSearchDatabaseFile(workspaceFolder);
        const tmpCacheFile = cacheFile + ".new";
        const stream = fs.createWriteStream(tmpCacheFile);
        stream.write(HEADLINE)
        // scan all folders in the workspace except those that use manually excluded

        const myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        myStatusBarItem.text = `indexing...`;
        myStatusBarItem.show();
        var count = 0
        const fileSet = new Set<string>();
        await walkFileTree(workspaceFolder, excludeDirs, (abs_path: string) => {
            // The end
            if (abs_path == null) {
                _updateFileListForWorkspace(workspaceFolder, pathsToIndexedFiles(fileSet))
                myStatusBarItem.hide();
                stream.end();
                log("found " + fileSet.size + " files under " + workspaceFolder);
                fs.rename(tmpCacheFile, cacheFile, () => {
                    log("wrote search database into " + cacheFile);
                });
                return;
            }

            var fileType = path.extname(abs_path);
            if (excludeFileTypes.has(fileType)) {
                logv("skip excluded file type: " + abs_path)
                return
            }

            if (!fileSet.has(abs_path)) {
                logv("found " + abs_path);
                fileSet.add(abs_path);
                stream.write(abs_path + "\n");
                myStatusBarItem.text = `indexing|` + (++count);
            }
        });
    }
    console.timeEnd("filepicker#buildSearchDatabase");
}


function shouldSkipFolder(dir: string/*abs path*/, name: string /*dir name*/, filters: string[] /*abs path*/) {
    // skip hidden folders
    if (name.charAt(0) == '.') {
        return true;
    }
    for (var filter of filters) {
        // and others whose is in the filter
        if (dir === filter || name === filter) {
            logv("excluded " + dir);
            return true;
        }
    }
    return false;
}

function shouldSkipFile(name: string, filters?: string[] /*abs path*/) {
    return name.charAt(0) == '.';
}

function parse_compile_db(dir: string, filters: string[], onNewFile: any) {
    var compile_db = path.join(dir, "compile_commands.json");
    if (!fs.existsSync(compile_db)) {
        logv("compile db not exist: " + compile_db)
        return false;
    }
    logv("Loading from " + compile_db)
    try {
        let file_contents = fs.readFileSync(compile_db, 'utf8')
        let compile_commands = JSON.parse(file_contents)
        for (var compile_command of compile_commands) {
            let parent_dir = compile_command["directory"]
            let file = compile_command["file"]
            let fullPath = file.startsWith("/") ? file: path.join(parent_dir, file)
            if (!parent_dir.startsWith(dir)
                    || shouldSkipFolder(fullPath, path.basename(fullPath), filters)) {
                logv("excluded " + fullPath);
            } else {
                onNewFile(fullPath);
            }
        }
        return true;
    } catch (error) {
        logv("Contents of compile db is not valid: " + compile_db)
    }
    return false;
}

function readFileListFromCompileDb(workspaceDir: string) {
    const fileSet: Set<string> = new Set();
    parse_compile_db(workspaceDir, [], (abs_path: string) => {
        var file = abs_path;
        if (!fileSet.has(file)) {
            logv("found " + file);
            fileSet.add(file)
        }
    })
    return fileSet
}

//  filters: string[] /* files in these folers will be indexed */
function walkFileTree(dir: string, filters: string[], onNewFile: any) {
    return new Promise((resolve, reject) => {
        // Always load the compile_commands.json if it exists under $dir
        parse_compile_db(dir, filters, onNewFile);
        readdirp(dir, {
            // Follow symlinks
            lstat: true,
            alwaysStat: true,
            fileFilter: (entry: any) => !shouldSkipFile(path.basename(entry.basename)),
            directoryFilter: (entry: any) => !shouldSkipFolder(entry.fullPath, entry.basename, filters),
        }).on('data', (entry: any) => onNewFile(entry.fullPath))
            .on('warn', (error: any) => logw('' + error))
            .on('error', (error: any) => loge('' + error))
            .on('end', () => {
                onNewFile(null);
                resolve(null);
            });
    });
}
