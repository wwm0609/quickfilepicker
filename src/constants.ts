
import * as vscode from 'vscode';
import { mkdirSync, existsSync } from 'fs';
import * as path from 'path';
const homedir = require('os').homedir();
export const ConfigDir = path.join(homedir, ".q_file_picker")

const Verbose = 1;
const Debug = 2;
const Info = 3;
const Warning = 4;
const Error = 5;
const NONE = 6;

var level = NONE;
var unixLike = -1;

var workSpaceToConfigDirMap = new Map()

export function getWorkspaceFolderOfRecentFileDatabase(databaseFile: string) {
    for (let [workSpaceFolder, configDir] of workSpaceToConfigDirMap) {
        if (databaseFile.startsWith(configDir)) {
            return workSpaceFolder;
        }
    }
    return null;
}

function getDatabaseDir(workspaceDir: string) {
    var workdir = workspaceDir ? workspaceDir : getWorkspaceFolder();
    if (workSpaceToConfigDirMap.has(workdir)) {
        return workSpaceToConfigDirMap.get(workdir);
    }
    // replace path seperator of unix and window styles to '@'
    var dir = path.join(ConfigDir, workdir.replace(/\//g, "@").replace(/\\/g, "@"));
    logd("map workspaceDir " + workdir + " to " + dir);
    if (!existsSync(dir)) {
        if (!existsSync(ConfigDir)) {
            mkdirSync(ConfigDir);
        }
        mkdirSync(dir);
    }
    workSpaceToConfigDirMap.set(workdir, dir);
    return dir;
}

function getFileIndexDatabasePath(workspaceDir: string) {
    return path.join(getDatabaseDir(workspaceDir), "file_index.db")
}

function getRecentlyFilesDatabasePath(workspaceDir: string) {
    return path.join(getDatabaseDir(workspaceDir), "recently_files.db")
}

export function isUnixLikeSystem() {
    if (unixLike == -1) {
        var dir = getWorkspaceFolder();
        unixLike = dir.startsWith("/") ? 1 : 0;
    }
    return unixLike == 1;
}

export function getSearchDatabaseFile(workspaceDir: string) {
    return getFileIndexDatabasePath(workspaceDir);
}

export function getRecentlyOpenedFilelistDatabases() {
    return getWorkspaceFolders().map(workspaceFolder => {
        return getRecentlyFilesDatabasePath(workspaceFolder);
    });
}

export function setLogLevel(new_level: string) {
    switch (new_level.toLowerCase()) {
        case "none": level = NONE; break;
        case "verbose": level = Verbose; break;
        case "debug": level = Debug; break;
        case "info": level = Info; break;
        case "warning": level = Warning; break;
        case "error": level = Error; break;
        default: level = NONE;
    }
    console.log("FilePicker: set log level to " + new_level)
}

export function logv(message: string) {
    if (Verbose >= level) {
        console.log("FilePicker: " + message);
    }
}

export function log(message: any) {
    if (Debug >= level) {
        console.log("FilePicker: " + message);
    }
}

export function logd(message: string) {
    if (Debug >= level) {
        console.log("FilePicker: " + message);
    }
}

export function logi(message: string) {
    if (Info >= level) {
        console.log("FilePicker: " + message);
    }
}

export function logw(message: string) {
    if (Warning >= level) {
        console.warn("FilePicker: " + message);
    }
}

export function loge(message: string) {
    if (Error >= level) {
        console.error("FilePicker: " + message);
    }
}


export function getWorkspaceFolders() {
    const cwds = vscode.workspace.workspaceFolders ?
        vscode.workspace.workspaceFolders.map(f => f.uri.fsPath) : [process.cwd()];
    return cwds;
}

export function getWorkspaceFolder() {
    return getWorkspaceFolders()[0];
}

export function buildShortName(fileName: string) {
    var result = "";
    var idx = 0;
    while (idx < fileName.length && fileName[idx] != '.') {
        if (fileName[idx] >= 'A' && fileName[idx] <= 'Z') {
            var prevIsLowerCase = idx == 0
                || (idx > 0 && fileName[idx - 1] <= 'z' && fileName[idx - 1] >= 'a');
            var nextIsLowerCase = (idx == fileName.length - 1)
                || (idx < fileName.length - 1 && fileName[idx + 1] <= 'z' && fileName[idx + 1] >= 'a');
            if (prevIsLowerCase && nextIsLowerCase) {
                result+= fileName[idx].toLowerCase();
            }
        }
        idx++;
    }
    if (result.length == 0) return result;
    return result + (idx < fileName.length ? fileName.substr(idx) : "");
}