import * as vscode from 'vscode';
import readline = require('readline');
import { log, logw, getRecentlyOpenedFilelistDatabases, logd, logv, getWorkspaceFolderOfRecentFileDatabase } from "./constants";
import fs = require('fs');

const recentlyOpenedFileList: string[] = []; // act like a LRU cache

export async function getRecentlyOpenedFileList() {
    await loadRecentlyOpenedFileListCache();
    return recentlyOpenedFileList;
}

// flag to rewrite cache
var recentOpenedFileListChanged = false;

export function removeFileFromHistory(file: string) {
    var index = recentlyOpenedFileList.indexOf(file);
    // the param file was already at the head of this LRU
    if (index < 0) {
        return;
    }

    logv("filepicker: " + file + " was removed from history");
    recentlyOpenedFileList.splice(index, 1);
    recentOpenedFileListChanged = true;
    setTimeout(persistRecentlyOpenedFileList, 1000);
}

export async function initRecentFileHistory() {
    vscode.window.onDidChangeActiveTextEditor((editor) => {
        var textEditor = editor ? editor : vscode.window.activeTextEditor;
        if (!textEditor) {
            return;
        }
        const file = textEditor.document.uri.fsPath;
        loadRecentlyOpenedFileListCache().then(() => {
            fs.exists(file, (exists) => {
                if (!exists) {
                    log("filepicker: " + file + " not exist on disk");
                    return;
                }
                recentOpenedFileListChanged = updateRecentlyOpenedFilesList(file)
                        || recentOpenedFileListChanged;
                if (recentOpenedFileListChanged) {
                    setTimeout(persistRecentlyOpenedFileList, 1000);
                }
            });
        });
    });
    var editor = vscode.window.activeTextEditor;
    if (editor) {
        const file = editor.document.uri.fsPath;
        loadRecentlyOpenedFileListCache().then(() => {
            updateRecentlyOpenedFilesList(file);
        });
    }
}

function updateRecentlyOpenedFilesList(file: string) {
    var index = recentlyOpenedFileList.indexOf(file);
    // the param file was already at the head of this LRU
    if (index == 0) {
        return false;
    }

    logv("filepicker: " + file + " was opened");
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
    getRecentlyOpenedFilelistDatabases().forEach(dbfile => {
        const stream = fs.createWriteStream(dbfile);
        stream.write("# Auto generated, please do not modify");
        const workspaceFolder = getWorkspaceFolderOfRecentFileDatabase(dbfile);
        if (!workspaceFolder) {
            logw("filepicker: con't find workspace folder for recently opened file list database: " + dbfile);
            return;
        }
        stream.write("# auto generated file, used to cache recently opened files\n");
        recentlyOpenedFileList.forEach((file) => {
            if (file.startsWith(workspaceFolder)) {
                stream.write(file + '\n');
            }
        });
        stream.end();
    })
    log("filepicker: changes of recently opened file list have been wrote to disk");
}


var fileListLoadedPromise:Promise<any>;
function loadRecentlyOpenedFileListCache() {
    if (fileListLoadedPromise) return fileListLoadedPromise;
    fileListLoadedPromise =  Promise.all(getRecentlyOpenedFilelistDatabases().map(file => {
        return new Promise((resolve, reject) => {
            fs.stat(file, (err, fileStat) => {
                if (err || !fileStat.isFile()) {
                    log("filepicker: recently opened files db not exist");
                    resolve();
                    return;
                }
                logd("filepicker: load recently opened file list db");
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
                    log("filepicker: recently opened file list loaded");
                });
            });
        });
    }))
    return fileListLoadedPromise;
}