
import * as vscode from 'vscode';
import { mkdirSync, existsSync } from 'fs';
import * as path from 'path';
export const ConfigDir = "./.q_file_picker/"
const FilePickerSearchtDatabaseFile = "./.q_file_picker/quick_open_file_list.db"
const FilePickerRecentlyOpenedFileListFile = "./.q_file_picker/quick_open_recently_files.db"

const Verbose = 1;
const Debug = 2;
const Info = 3;
const Warning = 4;
const Error = 5;
const NONE = 6;

var level = NONE;

export function getSearchDatabaseFile(workspaceDir: string) {
    ensureCacheDirSync(workspaceDir);
    return path.join(workspaceDir, FilePickerSearchtDatabaseFile);
}

export function getRecentlyOpenedFilelistDatabases() {
    return getWorkspaceFolders().map(workspaceFolder => {
        ensureCacheDirSync(workspaceFolder);
        return path.resolve(workspaceFolder, FilePickerRecentlyOpenedFileListFile);
    });
}

export function ensureCacheDirSync(workspaceFolder?: string) {
    var dir = path.resolve(workspaceFolder ? workspaceFolder : getWorkspaceFolder(), ConfigDir);
    if (!existsSync(dir)) mkdirSync(dir);
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
    console.log("filepicker: set log level to " + new_level)
}

export function logv(message: string) {
    if (Verbose >= level) {
        console.log(message);
    }
}

export function log(message: any) {
    if (Debug >= level) {
        console.log(message);
    }
}

export function logd(message: string) {
    if (Debug >= level) {
        console.log(message);
    }
}

export function logi(message: string) {
    if (Info >= level) {
        console.log(message);
    }
}

export function logw(message: string) {
    if (Warning >= level) {
        console.log(message);
    }
}

export function loge(message: string) {
    if (Error >= level) {
        console.log(message);
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

export function fuzzy_match_simple(pattern: string, str: string) {
    var patternIdx = 0;
    var strIdx = 0;
    var patternLength = pattern.length;
    var strLength = str.length;

    while (patternIdx != patternLength && strIdx != strLength) {
        var patternChar = pattern.charAt(patternIdx);
        var strChar = str.charAt(strIdx);
        if (patternChar == strChar)
            ++patternIdx;
        ++strIdx;
    }

    return patternLength != 0 && strLength != 0 && patternIdx == patternLength ? true : false;
}