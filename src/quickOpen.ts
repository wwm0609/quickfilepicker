/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import fs = require('fs');
import { Uri, window, Disposable, QuickPickItem, workspace } from 'vscode';


var WorkspaceConfigFolderName = '.vscode'
var QuickOpenCache = "quickOpenFileListCache"
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


function walkDir(dir: string, callback: { (abs_path: string): void; (arg0: string): void; }) {
	fs.readdirSync(dir).forEach(f => {
		let dirPath = path.join(dir, f);
		let stats = fs.lstatSync(dirPath);
		if (stats.isDirectory() && !f.startsWith(".") && f != '.repo' && f != '.git') {
			walkDir(dirPath, callback);
		} else if (stats.isFile() || stats.isSymbolicLink() && !f.startsWith(".")) {
			callback(path.join(dir, f))
		}
	});
};

function getConfigFolder(workspaceDir: string) {
	return path.join(workspaceDir, WorkspaceConfigFolderName);
}

function getFileListCache(workspaceDir: string) {
	return path.join(getConfigFolder(workspaceDir), QuickOpenCache);
}

export async function buildFileListCache() {
	const cwds = workspace.workspaceFolders ?
		workspace.workspaceFolders.map(f => f.uri.fsPath) : [process.cwd()];
	var walkspaceFolder = cwds[0];
	var project_config_folder = getConfigFolder(walkspaceFolder);
	try {
		if (!fs.existsSync(project_config_folder)) {
			console.log("dir not exist, creating now: " + project_config_folder);
			fs.mkdirSync(project_config_folder);
		}
		var tmp_file_list: string[] = []
		var cacheFile = getFileListCache(walkspaceFolder);
		var tmpCacheFile = cacheFile + ".new";
		var stream = fs.createWriteStream(tmpCacheFile);
		console.time("buildFileListCache");
		console.log("begin build file list: " + walkspaceFolder);
		await walkDir(walkspaceFolder, function (abs_path: string) {
			// use relative path
			// var relativePath = abs_path.replace(walkspaceFolder, ".")
			// console.log("found: " + relativePath);
			tmp_file_list.push(abs_path);
			// stream.write(relativePath + "\n");
			stream.write(abs_path + "\n");
		});
		file_list = tmp_file_list;
		stream.end();
		fs.renameSync(tmpCacheFile, cacheFile)
		console.log("summary: found " + tmp_file_list.length + " files");
		console.log("wrote cache file list into " + cacheFile);
		console.timeEnd("buildFileListCache");
	} catch (err) {
		console.error(err)
	}
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
	return matched || fuzzy_match_simple(pattern, file);
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

function queryCandidates(input: any, value: string) {
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
	fs.stat(cacheFile, (err) => {
		if (err != null) {
			input.items = input.items.concat([
				new MessageItem(Uri.file(cacheFile), "file list database not exist, please build it")
			])
			input.busy = false;
			console.log("cache file not exist", err);
			return;
		}

		var lines = file_list;
		// we already read the cache
		if (lines.length > 0) {
			prepareCandidates(input, lines, value, workspaceFolder);
			input.busy = false;
			return;
		}

		fs.readFile(cacheFile, { encoding: 'utf-8' }, function (err, data) {
			if (!err) {
				console.log("reading cache: " + cacheFile)
				var lines = data.split(/\r?\n/)
				file_list = lines;
				prepareCandidates(input, lines, value, workspaceFolder);
				input.busy = false;
				return;
			}

			input.items = input.items.concat([
				new MessageItem(Uri.file(cacheFile), "file list database broken, please rebuild it")
			])
			file_list = [];
			console.log("failed to loading cached file list", err);
			input.busy = false;
		});
	});
}

function prepareCandidates(input: any, lines: string[], value: string, workspaceFolder: string) {
	input.items = input.items.concat(lines.filter(function (element) {
		return isPatternMatch(value, element);
	}).map(abs_path => new FileItem(Uri.file(workspaceFolder), Uri.file(abs_path))));
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


// // the ranking algorithm needs tweak
// function prepareAndRankCandidates(lines: string[], value: string, workspaceFolder: string, input: any) {
// 	interface Item {
// 		path: string;
// 		value: number;
// 	}
// 	;
// 	lines = lines.filter(function (element) {
// 		return isPatternMatch(value, element);
// 	});
// 	var items: Item[] = [];
// 	for (let f of lines) {
// 		let relativePath = f.replace(workspaceFolder, "");
// 		let result = fuzzy_match(value, relativePath);
// 		let matched: boolean = result[0];
// 		let score: number = result[1];
// 		if (matched && score >= -80) {
// 			let item: Item = { path: f, value: score };
// 			items.push(item);
// 		}
// 	}
// 	items = items.sort((l, r) => r.value - l.value);
// 	input.items = input.items.concat(items
// 		.map(item => new FileItem(Uri.file(workspaceFolder), Uri.file(item.path))));
// }

// // Returns [bool, score, formattedStr]
// // bool: true if each character in pattern is found sequentially within str
// // score: integer; higher is better match. Value has no intrinsic meaning. Range varies with pattern. 
// //        Can only compare scores with same search pattern.
// // formattedStr: input str with matched characters marked in <b> tags. Delete if unwanted.
// function fuzzy_match(pattern: string, str: string): any[] {

// 	// Score consts
// 	let adjacency_bonus: number = 5;                // bonus for adjacent matches
// 	let separator_bonus: number = 10;               // bonus if match occurs after a separator
// 	var camel_bonus = 10;                   // bonus if match is uppercase and prev is lower
// 	var leading_letter_penalty = -3;        // penalty applied for every letter in str before the first match
// 	var max_leading_letter_penalty = -9;    // maximum penalty for leading letters
// 	var unmatched_letter_penalty = -1;      // penalty for every letter that doesn't matter

// 	// Loop variables
// 	let score: number = 0;
// 	var patternIdx = 0;
// 	var patternLength = pattern.length;
// 	var strIdx = 0;
// 	var strLength = str.length;
// 	var prevMatched = false;
// 	var prevLower = false;
// 	var prevSeparator = true;       // true so if first letter match gets separator bonus

// 	// Use "best" matched letter if multiple string letters match the pattern
// 	var bestLetter = null;
// 	var bestLower = null;
// 	var bestLetterIdx = -1;
// 	var bestLetterScore = 0;

// 	let matchedIndices: number[] = [];
// 	let formattedStr: string = "";

// 	// Loop over strings
// 	while (strIdx != strLength) {
// 		formattedStr = "";
// 		var patternChar = patternIdx != patternLength ? pattern.charAt(patternIdx) : null;
// 		var strChar = str.charAt(strIdx);
// 		var idx = 0;
// 		var patternLower = patternChar != null ? patternChar.toLowerCase() : null;
// 		var strLower = strChar.toLowerCase();
// 		var strUpper = strChar.toUpperCase();

// 		var nextMatch = patternChar && patternLower == strLower;
// 		var rematch = bestLetter && bestLower == strLower;

// 		var advanced = nextMatch && bestLetter;
// 		var patternRepeat = bestLetter && patternChar && bestLower == patternLower;
// 		if (advanced || patternRepeat) {
// 			score += bestLetterScore;
// 			matchedIndices.push(bestLetterIdx);
// 			bestLetter = null;
// 			bestLower = null;
// 			bestLetterIdx = -1;
// 			bestLetterScore = 0;
// 		}

// 		if (nextMatch || rematch) {
// 			var newScore = 0;

// 			// Apply penalty for each letter before the first pattern match
// 			// Note: std::max because penalties are negative values. So max is smallest penalty.
// 			if (patternIdx == 0) {
// 				var penalty = Math.max(strIdx * leading_letter_penalty, max_leading_letter_penalty);
// 				score += penalty;
// 			}

// 			// Apply bonus for consecutive bonuses
// 			if (prevMatched)
// 				newScore += adjacency_bonus;

// 			// Apply bonus for matches after a separator
// 			if (prevSeparator)
// 				newScore += separator_bonus;

// 			// Apply bonus across camel case boundaries. Includes "clever" isLetter check.
// 			if (prevLower && strChar == strUpper && strLower != strUpper)
// 				newScore += camel_bonus;

// 			// Update patter index IFF the next pattern letter was matched
// 			if (nextMatch)
// 				++patternIdx;

// 			// Update best letter in str which may be for a "next" letter or a "rematch"
// 			if (newScore >= bestLetterScore) {

// 				// Apply penalty for now skipped letter
// 				if (bestLetter != null)
// 					score += unmatched_letter_penalty;

// 				bestLetter = strChar;
// 				bestLower = bestLetter.toLowerCase();
// 				bestLetterIdx = strIdx;
// 				bestLetterScore = newScore;
// 			}

// 			prevMatched = true;
// 		}
// 		else {
// 			// Append unmatch characters
// 			formattedStr += strChar;

// 			score += unmatched_letter_penalty;
// 			prevMatched = false;
// 		}

// 		// Includes "clever" isLetter check.
// 		prevLower = strChar == strLower && strLower != strUpper;
// 		prevSeparator = strChar == '_' || strChar == ' ';

// 		++strIdx;
// 	}

// 	// Apply score for last match
// 	if (bestLetter) {
// 		score += bestLetterScore;
// 		matchedIndices.push(bestLetterIdx);
// 	}

// 	// Finish out formatted string after last pattern matched
// 	// Build formated string based on matched letters

// 	var lastIdx = 0;
// 	for (var i = 0; i < matchedIndices.length; ++i) {
// 		var idx = matchedIndices[i];
// 		formattedStr += str.substr(lastIdx, idx - lastIdx) + "<b>" + str.charAt(idx) + "</b>";
// 		lastIdx = idx + 1;
// 	}
// 	formattedStr += str.substr(lastIdx, str.length - lastIdx);

// 	let matched: boolean = patternIdx == patternLength;
// 	return [matched, score, formattedStr];
// }

