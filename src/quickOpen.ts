/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import fs = require('fs');
import readline = require('readline');
import { Uri, window, Disposable, QuickPickItem, workspace, QuickPick } from 'vscode';
import { promisify } from 'util';
const readdir = promisify(fs.readdir);
const lstat = promisify(fs.lstat);


var QuickOpenCache = ".quick_open_file_list.db"
var file_list: string[] = []


/**
 * A file opener using window.createQuickPick().
 * 
 * It shows how the list of items can be dynamically updated based on
 * the user's input in the filter field.
 */
export async function quickOpen() {
	const uri = await pickFile();
	if (uri) {
		const document = await workspace.openTextDocument(uri);
		await window.showTextDocument(document);
	}
}

function shouldSkipFolder(dir: string/*abs path*/, name: string, filters: string[] /*abs path*/) {
	return filters.indexOf(dir) >= 0 || name.charAt(0) == '.';
}

function shouldSkipFile(name: string, filters: string[] /*abs path*/) {
	return name.charAt(0) == '.';
}

// grab all files under param dir recusively
// if the callback param is provided, return an empty list
export function getFilesSync(dir: string, filters: string[], onNewFile: any) {
	const folders: string[] = [];
	folders.push(dir);
	const results = [];

	while (folders.length > 0) {
		let head = folders.shift(); // remove the head
		let dir: string = ""
		if (typeof head === 'string') {
			dir = head
		} else {
			continue;
		}
		try {
			const files = fs.readdirSync(dir);
			for (var name of files) {
				var abs_file = path.join(dir, name);
				let fileStat: fs.Stats;
				try {
					fileStat = fs.lstatSync(abs_file)
				} catch (e) {
					console.log(e);
					continue;
				}
				if (fileStat.isDirectory()) {
					if (!shouldSkipFolder(dir, name, filters)) {
						folders.push(abs_file)
					} else {
						console.log("quick file picker: skip scanning folder " + abs_file)
					}
				} else if (fileStat.isFile()) {
					if (!shouldSkipFile(name, [])) {
						if (onNewFile != null) {
							onNewFile(abs_file);
						} else {
							results.push(abs_file);
						}
					}
				} else if (fileStat.isSymbolicLink()) {
					// TODO: check if it points to a file or dir
					continue;
				}
			}
		} catch (e) {
			console.log(e);
		}
	}
	return results;
}

async function walkFileTree(dir: string, filters: string[], onNewFile: any) {
	const subdirs = await readdir(dir);
	await Promise.all(subdirs.map(async (name: string) => {
		const abs_file = path.join(dir, name);
		var fileStat = await lstat(abs_file);
		if (fileStat.isDirectory()) {
			return !shouldSkipFolder(abs_file, name, filters) ? walkFileTree(abs_file, filters, onNewFile) : "";
		}
		if (fileStat.isFile()) {
			if (!shouldSkipFile(name, [])) {
				onNewFile(abs_file);
			}
		} else if (fileStat.isSymbolicLink()) {
			// TODO: follow link?
		}
		return ""
	}));
	return "";
}

function getFileListCache(workspaceDir: string) {
	return path.join(workspaceDir, QuickOpenCache);
}

export async function buildFileListCache(workspaceFolder: string, excludeDirs: string[], onNewFile: any) {
	console.time("buildFileListCache");
	console.log("begin build file list: " + workspaceFolder + ", exclude dirs=" + excludeDirs);
	const tmp_file_list: string[] = []
	const cacheFile = getFileListCache(workspaceFolder);
	const tmpCacheFile = cacheFile + ".new";
	const stream = fs.createWriteStream(tmpCacheFile);
	stream.write("# This is database file auto generated by quick file picker, please don't modify it directly\n# You better add it into your project's .gitignore file")
	let promise = new Promise((resolve, reject) => {
		walkFileTree(workspaceFolder, excludeDirs, (abs_path: string) => {
			var file = abs_path.replace(workspaceFolder, ".");
			// console.log("found: " + file);
			onNewFile(file);
			tmp_file_list.push(file);
			stream.write(file + "\n");
		}).then(() => {
			stream.end();
			file_list = tmp_file_list;
			fs.rename(tmpCacheFile, cacheFile, () => resolve("done"))
		});
	});
	await promise;
	console.log("summary: found " + tmp_file_list.length + " files");
	console.log("wrote cache file list into " + cacheFile);
	console.timeEnd("buildFileListCache");
	return cacheFile;
}

class FileItem implements QuickPickItem {
	label: string;
	description: string;

	constructor(public base: Uri, public uri: Uri) {
		this.label = path.basename(uri.fsPath);
		this.description = path.dirname(path.relative(base.fsPath, uri.fsPath));
	}
}

class MessageItem implements QuickPickItem {

	label: string;
	description = '';
	detail: string;

	constructor(public base: Uri, public message: string) {
		this.label = message.replace(/\r?\n/g, ' ');
		this.detail = base.fsPath;
	}
}

function isPatternMatch(pattern: string, file: string) {
	var matched = file.toLowerCase().includes(pattern.toLocaleLowerCase());
	// console.log("isPatternMatch: matched=" + matched + ", key=" + pattern + ", file=" + file);
	return matched || fuzzy_match_simple(pattern, path.basename(file));
}

function fuzzy_match_simple(pattern: string, str: string) {
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

function queryCandidates(input:QuickPick<FileItem|MessageItem>, value: string) {
	console.log("queryCandidates: pattern=" + value);
	input.items = [];
	if (!value) {
		return;
	}
	input.busy = true;
	const cwds = workspace.workspaceFolders ?
		workspace.workspaceFolders.map(f => f.uri.fsPath) : [process.cwd()];
	var workspaceFolder = cwds[0];
	var cacheFile = getFileListCache(workspaceFolder);
	fs.lstat(cacheFile, (err) => {
		if (err != null) {
			input.items = input.items.concat([
				new MessageItem(Uri.file(cacheFile), "file list database not exist, please build it")
			])
			input.busy = false;
			console.log("cache file not exist", err);
			return;
		}

		console.time("fastfilepicker: queryCandidates");
		var lines = file_list;
		// we already read the cache
		if (lines.length > 0) {
			prepareCandidates(input, lines, value, workspaceFolder);
			input.busy = false;
			console.timeEnd("fastfilepicker: queryCandidates");
			return;
		}

		fs.readFile(cacheFile, { encoding: 'utf-8' }, function (err, data) {
			if (!err) {
				console.log("reading cache: " + cacheFile)
				const readInterface = readline.createInterface({
					input: fs.createReadStream(cacheFile),
					output: process.stdout,
				});
				const lines: string[] = [];
				readInterface.on('line', function (line: string) {
					if (line.length > 0 && !line.startsWith('#')) {
						lines.push(line);
					}
				});
				file_list = lines;
				prepareCandidates(input, lines, value, workspaceFolder);
				console.timeEnd("fastfilepicker: queryCandidates");
				input.busy = false;
				return;
			}

			input.items = input.items.concat([
				new MessageItem(Uri.file(cacheFile), "file list database broken, please rebuild it")
			])
			file_list = [];
			console.log("failed to loading cached file list", err);
			input.busy = false;
			console.timeEnd("fastfilepicker: queryCandidates");
		});
	});
}

function prepareCandidates(input: QuickPick<FileItem|MessageItem>, lines: string[], value: string, workspaceFolder: string) {
	console.time("fastfilepicker: prepareCandidates");
	input.items = input.items.concat(lines.filter(function (element) {
		return isPatternMatch(value, element);
	}).map(file => new FileItem(Uri.file(workspaceFolder), Uri.file(path.join(workspaceFolder, file)))));
	console.timeEnd("fastfilepicker: prepareCandidates");
}

async function pickFile() {
	const disposables: Disposable[] = [];
	try {
		return await new Promise<Uri | undefined>((resolve, reject) => {
			const input = window.createQuickPick<FileItem | MessageItem>();
			const timeoutObjs: any[] = []
			input.placeholder = 'Type to search for files';
			disposables.push(
				input.onDidChangeValue(key => {
					if (timeoutObjs.length > 0) {
						console.log("cancel previous tasks");
						clearTimeout(timeoutObjs[0]);
						timeoutObjs.splice(0, timeoutObjs.length);
					}
					const pattern = key;
					const timeoutObj = setTimeout(queryCandidates, 200, input, pattern);
					timeoutObjs.push(timeoutObj);
				}),
				input.onDidChangeSelection(items => {
					const item = items[0];
					if (item instanceof FileItem) {
						resolve(item.uri);
						input.hide();
					}
				}),
				input.onDidHide(() => {
					resolve(undefined);
					input.dispose();
				})
			);
			input.show();
		});
	} finally {
		disposables.forEach(d => d.dispose());
	}
}