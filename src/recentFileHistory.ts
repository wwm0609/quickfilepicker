import * as vscode from 'vscode';
import readline = require('readline');
import { RecentlyOpenedFileCacheFile, getWorkspaceDir, QuickOpenFileListDatabaseFile } from "./constants";
import fs = require('fs');
import * as path from 'path';


export const recentlyOpenedFileList: string[] = []
var cacheFileOverdue = false;

export function initRecentFileHistory() {
    // flush every 30 sec
    setInterval(persistRecentlyOpenedFileNames, 60000, recentlyOpenedFileList);
    readRecentlyOpenedFileNames();

    vscode.workspace.onDidOpenTextDocument((e: vscode.TextDocument) => {
        // vscode seems emiting xxx.txt.git after xxx.txt emited, we have to ignore that
        fs.lstat(e.uri.fsPath, (err) => {
            if (err) {
                return;
            }
            updateRecentlyOpenedFilesList(e.uri.fsPath, recentlyOpenedFileList);
        });
    });
}


function updateRecentlyOpenedFilesList(file: string, results: string[]) {
    const workspaceDir = getWorkspaceDir();
    // don't record files not located in this workspace
    if (file.indexOf(workspaceDir) < 0) {
        console.log("filepicker: #updateRecentlyOpenedFilesList: ingore " + file);
        return;
    }
    var file = file.replace(workspaceDir, ".");
    if (file.indexOf(RecentlyOpenedFileCacheFile) >= 0 || file.indexOf(QuickOpenFileListDatabaseFile) >= 0) {
        return;
    }
    console.log("filepicker: opened " + file);
    var index = -1;
    if ((index = results.indexOf(file)) >= 0) {
        results.splice(index, 1);
    }
    results.unshift(file);
    if (results.length > 25 /* keep track of this amount of most recently opened files */) {
        results.splice(25, results.length - 25);
    }
    cacheFileOverdue = true;
}

function persistRecentlyOpenedFileNames(fileList: string[]) {
    if (!cacheFileOverdue) return;
    var file = getRecentlyOpenedFilesCacheFile();
    const stream = fs.createWriteStream(file);
    stream.write("# auto generated file, used to cache recently opened files\n");
    fileList.forEach((file) => {
        stream.write(file + '\n');
    });
    stream.end();
    cacheFileOverdue = false;
    console.log("filepicker: persist recently opened file names to disk");
}

function getRecentlyOpenedFilesCacheFile() {
    const workspaceDir = getWorkspaceDir();
    var file = path.resolve(workspaceDir, RecentlyOpenedFileCacheFile);
    return file;
}

function readRecentlyOpenedFileNames() {
    var file = getRecentlyOpenedFilesCacheFile();
    fs.stat(file, (err, fileStat) => {
        if (err || !fileStat.isFile()) {
            console.log("filepicker: recently opened file cache not exist");
            return;
        }

        const readInterface = readline.createInterface({
            input: fs.createReadStream(file),
            output: process.stdout,
        });
        var lines: string[] = []
        readInterface.on('line', function (line: string) {
            if (line.length > 0 && !line.startsWith('#')) {
                updateRecentlyOpenedFilesList(line, lines)
            }
        });
        readInterface.on('close', () => {
            recentlyOpenedFileList.splice(0, recentlyOpenedFileList.length).push(...lines);
        });
    });
}