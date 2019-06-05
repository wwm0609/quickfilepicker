
import * as vscode from 'vscode';
import { mkdirSync, existsSync } from 'fs';
import * as path from 'path';
export const ConfigDir = "./.q_file_picker/"
export const FilePickerSearchtDatabaseFile = "./.q_file_picker/quick_open_file_list.db"
export const FilePickerRecentlyOpenedFileListFile = "./.q_file_picker/quick_open_recently_files.db"

export function ensureCacheDirSync() {
    var dir = path.resolve(getWorkspaceDir(), ConfigDir);
    if (!existsSync(dir)) mkdirSync(dir);
}

export function getWorkspaceDir() {
    const cwds = vscode.workspace.workspaceFolders ?
        vscode.workspace.workspaceFolders.map(f => f.uri.fsPath) : [process.cwd()];
    return cwds[0];
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