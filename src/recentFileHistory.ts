import * as vscode from 'vscode';
import readline = require('readline');
import { FilePickerRecentlyOpenedFileListFile, log, ensureCacheDirSync, getWorkspaceFolders, logw } from "./constants";
import fs = require('fs');
import * as path from 'path';


const recentlyOpenedFileList: string[] = []; // act like a LRU cache

export async function getRecentlyOpenedFileList() {
    await loadRecentlyOpenedFileListCache();
    return recentlyOpenedFileList;
}

// flag to rewrite cache
var recentOpenedFileListChanged = false;

export function initRecentFileHistory() {
    // flush changes every 10 sec
    setInterval(persistRecentlyOpenedFileList, 10000);
    var editor = vscode.window.activeTextEditor;
    if (editor) {
        var file = editor.document.uri.fsPath;
        updateRecentlyOpenedFilesList(file);
    }

    vscode.window.onDidChangeActiveTextEditor((editor) => {
        var textEditor = editor ? editor : vscode.window.activeTextEditor;
        if (!textEditor) {
            return;
        }
        var file = textEditor.document.uri.fsPath;
        fs.exists(file, (exists) => {
            if (!exists) {
                log("filepicker: " + file + " not exist on disk");
                return;
            }
            recentOpenedFileListChanged = updateRecentlyOpenedFilesList(file) || recentOpenedFileListChanged;
        });
    });
}

function updateRecentlyOpenedFilesList(file: string) {
    var index = recentlyOpenedFileList.indexOf(file);
    // the param file was already at the head of this LRU
    if (index == 0) {
        return false;
    }

    log("filepicker: just opened " + file);
    if (index > 0) recentlyOpenedFileList.splice(index, 1);
    recentlyOpenedFileList.unshift(file);
    const max_count = 50; /* keep track of this amount of most recently opened files */
    if (recentlyOpenedFileList.length > max_count) {
        recentlyOpenedFileList.splice(max_count, recentlyOpenedFileList.length - max_count);
    }
    return true;
}

function persistRecentlyOpenedFileList() {
    if (!recentOpenedFileListChanged) return;
    recentOpenedFileListChanged = false;
    getRecentlyOpenedFilelistDatabase().forEach(dbfile => {
        const stream = fs.createWriteStream(dbfile);
        stream.write("# Auto generated, please do not modify");
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dbfile));
        if (!workspaceFolder) {
            logw("filepicker: con't find workspace folder for recently opened file list database: " + dbfile);
            return;
        }
        const workspaceFolderPath = workspaceFolder.uri.fsPath;
        stream.write("# auto generated file, used to cache recently opened files\n");
        recentlyOpenedFileList.forEach((file) => {
            if (file.startsWith(workspaceFolderPath)) {
                stream.write(file + '\n');
            }
        });
        stream.end();
    })
    log("filepicker: changes of recently opened file list have been wrote to disk");
}

function getRecentlyOpenedFilelistDatabase() {
    return getWorkspaceFolders().map(workspaceFolder => {
        ensureCacheDirSync(workspaceFolder);
        return path.resolve(workspaceFolder, FilePickerRecentlyOpenedFileListFile);
    });
}

function loadRecentlyOpenedFileListCache() {
    if (recentlyOpenedFileList.length > 0) return recentlyOpenedFileList;

    return Promise.all(getRecentlyOpenedFilelistDatabase().map(file => {
        return new Promise((resolve, reject) => {
            fs.stat(file, (err, fileStat) => {
                if (err || !fileStat.isFile()) {
                    log("filepicker: recently opened file cache not exist");
                    resolve();
                    return;
                }
                log("filepicker: begin loadRecentlyOpenedFileListCache");
                log("filepicker: load recently opened file list cache");
                const readInterface = readline.createInterface({
                    input: fs.createReadStream(file),
                    output: process.stdout,
                });
                readInterface.on('line', function (line: string) {
                    if (line.length > 0 && !line.startsWith('#')) {
                        updateRecentlyOpenedFilesList(line)
                    }
                });
                readInterface.on('close', () => {
                    resolve();
                    log("filepicker: begin loadRecentlyOpenedFileListCache");
                });
            });
        });
    }))


}