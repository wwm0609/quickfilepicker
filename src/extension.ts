/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { quickOpen, buildFileListCache, QuickOpenFileListDatabaseFile } from './quickOpen';
import { commands, ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import * as path from 'path';
import readline = require('readline');
import fs = require('fs');

let myStatusBarItem: vscode.StatusBarItem;
let isBuildingFileList: boolean = false;
myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

const recentlyOpenedFileList:string[] = []

export function activate(context: ExtensionContext) {
	const workspaceDir = getWorkspaceDir();
	console.log("FastFilePicker: activated for " + workspaceDir);
	context.subscriptions.push(commands.registerCommand('wwm.quickInput', async () => {
		console.log("damn vscode2");
		quickOpen(recentlyOpenedFileList);
	}));
	context.subscriptions.push(commands.registerCommand('wwm.buildFileList', async () => {
		if (isBuildingFileList) {
			vscode.window.showInformationMessage("fast picker: busy now, please try later");
			return;
		}
		isBuildingFileList = true;
		console.log("damn vscode1");
		myStatusBarItem.text = `filepicker: indexing...`;
		myStatusBarItem.show();
		// const configuration = vscode.workspace.getConfiguration();
		// const currentValue = configuration.get('conf.resource.insertEmptyLastLine');
		// todo: read exclude dirs from configuration
		var excludeDirs = ["out", 'test', 'vendor', 'cts', 'tools', 'src/tools', ".repo", "node_modules"]
			.map(folder => path.join(workspaceDir, folder));
		// var excludeFilePatterns:string[] = []
		var count = 0;
		const intervalObj = setInterval(function () {
			myStatusBarItem.text = `filepicker: ` + count
		}, 100)
		buildFileListCache(workspaceDir, excludeDirs, () => {
			++count
		}).then(database => {
			isBuildingFileList = false;
			clearInterval(intervalObj);
			myStatusBarItem.hide();
			vscode.window.showInformationMessage("fast picker: indexing finished, see " + database);
		}).catch((err) => {
			isBuildingFileList = false;
			console.log("failed to build file list database", err);
		});
	}));

	// flush every 30 sec
	setInterval(persistRecentlyOpenedFileNames, 30000, recentlyOpenedFileList);
	readRecentlyOpenedFileNames();

	vscode.workspace.onDidOpenTextDocument((e:vscode.TextDocument) => {
		// vscode seems emiting xxx.txt.git after xxx.txt emited, we have to ignore that
		fs.lstat(e.uri.fsPath, (err, fileStat) => {
			if (err) {
				console.log("filepicker: file not exist on disk, ignore it");
				return;
			}
			updateRecentlyOpenedFilesList(e.uri.fsPath, recentlyOpenedFileList);
		});
	});
}

function updateRecentlyOpenedFilesList(file:string, results:string[]) {
	var file = file.replace(getWorkspaceDir(), ".");
	if (file.indexOf(recentlyOpenedFileCacheFile) >= 0 || file.indexOf(QuickOpenFileListDatabaseFile) >= 0) {
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
}

let recentlyOpenedFileCacheFile = ".quick_open_recently_files.db"

function getWorkspaceDir() {
	const cwds = vscode.workspace.workspaceFolders ?
		vscode.workspace.workspaceFolders.map(f => f.uri.fsPath) : [process.cwd()];
	return cwds[0];
}

function persistRecentlyOpenedFileNames(fileList:string[]) {
	var file = getRecentlyOpenedFilesCacheFile();
	const stream = fs.createWriteStream(file);
	stream.write("# auto generated file, used to cache recently opened files\n");
	fileList.forEach((file) => {
		stream.write(file + '\n');
	});
	stream.end();
	console.log("filepicker: persist recently opened file names to disk");
}

function getRecentlyOpenedFilesCacheFile() {
	const workspaceDir = getWorkspaceDir();
	return path.join(workspaceDir, recentlyOpenedFileCacheFile);
}

function readRecentlyOpenedFileNames() {
	var file = getRecentlyOpenedFilesCacheFile();
	fs.stat(file, (err, fileStat)=>{
		if (err) {
			console.log("filepicker: recently opened files db not exist", err);
		}
		if (fileStat.isFile()) {
			const readInterface = readline.createInterface({
				input: fs.createReadStream(file),
				output: process.stdout,
			});
			var lines:string[] = []
			readInterface.on('line', function (line: string) {
				if (line.length > 0 && !line.startsWith('#')) {
					updateRecentlyOpenedFilesList(line, lines)
				}
			});
			readInterface.on('close', () => {
				recentlyOpenedFileList.splice(0, recentlyOpenedFileList.length).push(...lines);
			});
		} else {
			console.log("filepicker: recently opened files db not exist");
		}
	});
}