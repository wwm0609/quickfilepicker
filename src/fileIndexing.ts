import fs = require('fs');
import { getWorkspaceFolder, getWorkspaceFolders, log, logv, getSearchDatabaseFile, logw, loge } from "./constants";
import readline = require('readline');
import * as path from 'path';
import * as vscode from 'vscode';
import readdirp = require('readdirp');


const fileListMap: Map<string, string[]> = new Map();

const HEADLINE = "# Auto generated, please don't modify it directly\n"
    + "# You might want to add it into your project's .gitignore\n";

function _getFileListOfWorkspaceFolder(workspaceFolder: string) {
    var fileList = fileListMap.get(workspaceFolder);
    if (!fileList) {
        fileList = [];
        fileListMap.set(workspaceFolder, fileList);
    }
    return fileList;
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
        const file_list: string[] = []
        fileListMap.set(workspaceFolder, file_list);
        return new Promise((resolve, reject) => {
            var databaseFile = getSearchDatabaseFile(workspaceFolder);
            if (!fs.existsSync(databaseFile)) {
                log("filepicker: search datababse not exist");
                resolve();
            }

            console.time("filepicker_loadSearchDatabase");
            log("filepicker: loading search datababse at " + databaseFile)
            const readInterface = readline.createInterface({
                input: fs.createReadStream(databaseFile),
                output: process.stdout,
            });
            readInterface.on('line', function (line: string) {
                if (line.length > 0 && !line.startsWith('#')) {
                    file_list.push(line);
                }
            });
            readInterface.on('close', () => {
                log("filepicker: just loaded " + databaseFile);
                console.timeEnd("filepicker_loadSearchDatabase");
                resolve();
            });
        });
    }));
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
            log("filepicker: #updateIncludeAndExcludeDirs, illegal dir: " + dir + " not in workspace");
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
        log("filepicker: already excluded: " + dirs);
        return;
    }

    saveWorkspaceConfiguration(currentExcludeDirs);

    var workspaceFoldersNeedToReScanned = [];
    for (var workspaceDir of workspaceDirs) {
        if (!fs.existsSync(getSearchDatabaseFile(getWorkspaceFolder()))) {
            log("filepicker: search datababse for workspace folder" + workspaceDir);
            vscode.window.showInformationMessage("Search database for workspace folder: " + workspaceDir
                + " not exist, don't forget to build it later");
            continue;
        }
        workspaceFoldersNeedToReScanned.push(workspaceDir);
    }
    if (workspaceFoldersNeedToReScanned.length == 0) {
        log("filepicker: no available search databases");
        return;
    }

    await loadSearchDatabaseAsync();

    const myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    myStatusBarItem.text = `filepicker: exclude|0`;
    myStatusBarItem.show();
    var count = 0
    // update files list: remove excluded files
    await Promise.all(newExcludeDirs.map((dir) => {
        var workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir));
        const workspaceDir = workspaceFolder ? workspaceFolder.uri.fsPath : "";
        const fileList = _getFileListOfWorkspaceFolder(workspaceDir);
        return walkFileTree(dir, currentExcludeDirs, (abs_path: string) => {
            const file = abs_path;
            logv("filepicker: remove " + file);
            // todo: indexof is expensive
            var index = fileList.indexOf(file);
            if (index >= 0) {
                myStatusBarItem.text = `filepicker: exclude|` + (++count);
                myStatusBarItem.show();
                fileList.splice(index, 1);
            }
        });
    }));
    myStatusBarItem.hide();
    log("filepicker: #addExcludeDirs, just excluded " + newExcludeDirs);
    persistFileListToDisk();
}

export async function cancelExcludeDirs(cancelExcludeDirs: string[]) {
    var workspaceDirs = getWorkspaceFolders();
    const currentExcludeDirs = loadExcludedDirs();
    const newDirs: string[] = []
    cancelExcludeDirs.sort((a, b) => a.length - b.length).forEach((dir: string) => {
        // assert
        if (!isDirectoryInsideWorkspace(dir, workspaceDirs)) {
            log("filepicker: #updateIncludeAndExcludeDirs, illegal dir: " + dir + " not in workspace");
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
        log("filepicker: #cancelExcludeDirs, nothing canceled");
        return;
    }

    saveWorkspaceConfiguration(currentExcludeDirs);


    var workspaceFoldersNeedToIndexed = [];
    for (var workspaceDir of workspaceDirs) {
        if (!fs.existsSync(getSearchDatabaseFile(getWorkspaceFolder()))) {
            log("filepicker: search datababse for workspace folder" + workspaceDir);
            vscode.window.showInformationMessage("Search database for workspace folder: " + workspaceDir
                + " not exist, don't forget to build it later");
            continue;
        }
        workspaceFoldersNeedToIndexed.push(workspaceDir);
    }
    if (workspaceFoldersNeedToIndexed.length == 0) {
        log("filepicker: no available search databases");
        return;
    }


    await loadSearchDatabaseAsync();

    const myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    myStatusBarItem.text = `filepicker: incremental indexing...`;
    myStatusBarItem.show();
    var count = 0

    // update search datababse: index files in those dirs we just unexcluded
    await Promise.all(newDirs.map((dir) => {
        var workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir));
        const workspaceDir = workspaceFolder ? workspaceFolder.uri.fsPath : "";
        const fileList = _getFileListOfWorkspaceFolder(workspaceDir);
        return walkFileTree(dir, currentExcludeDirs, (abs_path: string) => {
            var file = abs_path;
            // todo: indexof is expensive
            if (fileList.indexOf(file) < 0) {
                logv("filepicker: found " + file);
                fileList.push(file);
                myStatusBarItem.text = `filepicker: incremental indexing|` + (++count);
            }
        });
    }));
    myStatusBarItem.hide();
    log("filepicker: #cancelExcludeDirs, just indexed " + newDirs);

    persistFileListToDisk();
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
        fileList.forEach((item: string) => {
            stream.write(item + "\n");
        });
        stream.end();
        fs.rename(pathOfNewDb, pathOfDb, () => {
            log("filepicker: search database file for workspace foler " + workspaceFolder + " was updated");
        });
    });
}

export async function buildSearchDatabase() {
    var excludeDirs = loadExcludedDirs();
    console.time("filepicker#buildSearchDatabase");
    for (var workspaceFolder of getWorkspaceFolders()) {
        log("filepicker: begin build search database for " + workspaceFolder + ", exclude dirs: " + excludeDirs);
        const cacheFile = getSearchDatabaseFile(workspaceFolder);
        const fileList = _getFileListOfWorkspaceFolder(workspaceFolder)
        const tmpCacheFile = cacheFile + ".new";
        const stream = fs.createWriteStream(tmpCacheFile);
        stream.write(HEADLINE)
        // scan all folders in the workspace except those that use manually excluded

        const myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        myStatusBarItem.text = `filepicker: indexing...`;
        myStatusBarItem.show();
        var count = 0
        fileList.length = 0;
        await walkFileTree(workspaceFolder, excludeDirs, (abs_path: string) => {
            logv("filepicker: found " + abs_path);
            fileList.push(abs_path);
            stream.write(abs_path + "\n");
            myStatusBarItem.text = `filepicker: indexing|` + (++count);
        });
        myStatusBarItem.hide();
        stream.end();
        log("filepicker: found " + fileList.length + " files under " + workspaceFolder);
        fs.rename(tmpCacheFile, cacheFile, () => {
            log("filepicker: wrote search database into " + cacheFile);
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
            return true;
        }
    }
    return false;
}

function shouldSkipFile(name: string, filters?: string[] /*abs path*/) {
    return name.charAt(0) == '.';
}

//  filters: string[] /* files in these folers will be indexed */
function walkFileTree(dir: string, filters: string[], onNewFile: any) {
    return new Promise((resolve, reject) => {
        readdirp(dir, {
            fileFilter: (entry: any) => !shouldSkipFile(path.basename(entry.basename)),
            directoryFilter: (entry: any) => !shouldSkipFolder(entry.fullPath, entry.basename, filters),
        }).on('data', (entry: any) => onNewFile(entry.fullPath))
            .on('warn', (error: any) => logw('filepicker: ' + error))
            .on('error', (error: any) => loge('filepicker: ' + error))
            .on('end', () => resolve());
    });
}
