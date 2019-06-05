import * as vscode from 'vscode';
import readline = require('readline');
import { FilePickerRecentlyOpenedFileListFile, getWorkspaceDir } from "./constants";
import fs = require('fs');
import * as path from 'path';


const recentlyOpenedFileList: string[] = [];

export function getRecentlyOpenedFileList() {
    return recentlyOpenedFileList;
}

// flag to rewrite cache
var recentOpenedFileListChanged = false;

export function initRecentFileHistory() {
    // flush every 10 sec
    setInterval(persistRecentlyOpenedFileNames, 10000);
    loadRecentlyOpenedFileListCache();
    var editor = vscode.window.activeTextEditor;
    if (editor) {
        var file =  editor.document.uri.fsPath;
        recordOpenedFile(file);
    }

    vscode.window.onDidChangeActiveTextEditor((editor) => {
        var textEditor = editor ? editor : vscode.window.activeTextEditor;
        if (!textEditor) {
            return;
        }
        var file = textEditor.document.uri.fsPath;
        recordOpenedFile(file);
        recentOpenedFileListChanged = (recentOpenedFileListChanged || recordOpenedFile(file));
    });
}


function recordOpenedFile(file:string) {
    var workspaceDir = getWorkspaceDir()
    // don't record files not in this workspace
    if (file.indexOf(workspaceDir) < 0) {
        console.log("filepicker: #updateRecentlyOpenedFilesList: ingore " + file);
        return false;
    }
    file = file.replace(workspaceDir, ".");
    console.log("filepicker: opened " + file);
    return updateRecentlyOpenedFilesList(file);
}


function updateRecentlyOpenedFilesList(file: string) {
    var lines = recentlyOpenedFileList;
    var index = -1;
    if ((index = lines.indexOf(file)) >= 0) {
        lines.splice(index, 1);
    }
    lines.unshift(file);
    const max_count = 25; /* keep track of this amount of most recently opened files */
    if (lines.length > max_count) {
        lines.splice(max_count, lines.length - max_count);
    }
    return true;
}

function persistRecentlyOpenedFileNames(fileList: string[]) {
    if (!recentOpenedFileListChanged) return;
    var file = getRecentlyOpenedFilesCacheFile();
    const stream = fs.createWriteStream(file);
    stream.write("# auto generated file, used to cache recently opened files\n");
    fileList.forEach((file) => {
        stream.write(file + '\n');
    });
    stream.end();
    recentOpenedFileListChanged = false;
    console.log("filepicker: persist recently opened file names to disk");
}

function getRecentlyOpenedFilesCacheFile() {
    const workspaceDir = getWorkspaceDir();
    var file = path.resolve(workspaceDir, FilePickerRecentlyOpenedFileListFile);
    return file;
}

function loadRecentlyOpenedFileListCache() {
    var file = getRecentlyOpenedFilesCacheFile();
    fs.stat(file, (err, fileStat) => {
        if (err || !fileStat.isFile()) {
            console.log("filepicker: recently opened file cache not exist");
            return;
        }

        console.log("filepicker: load recently opened file list cache");
        const readInterface = readline.createInterface({
            input: fs.createReadStream(file),
            output: process.stdout,
        });
        readInterface.on('line', function (line: string) {
            if (line.length > 0 && !line.startsWith('#')) {
                updateRecentlyOpenedFilesList(line)
            }
        });
    });
}