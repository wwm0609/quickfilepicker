import * as path from 'path';
import { Uri, window, Disposable, QuickPickItem, workspace, QuickPick } from 'vscode';
import { getWorkspaceFolders, fuzzy_match_simple, log } from "./constants";
import { getFileListOfWorkspaceFolder } from './fileIndexing';
import { getRecentlyOpenedFileList } from './recentFileHistory'
import * as vscode from 'vscode';

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
		// todo: handle none text file
		await window.showTextDocument(document);
	}
}

class FileItem implements QuickPickItem {
	label: string;
	description: string;
	detail: string;
	uri: Uri;

	static fromUri(uri: Uri, showFullPathAsDetail?: boolean) {
		var abspath = uri.fsPath;
		var workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
		if (workspaceFolder) {
			var name = workspaceFolder.name.toUpperCase();
			var prefix = "./";
			return new FileItem(uri, prefix + vscode.workspace.asRelativePath(abspath), name, showFullPathAsDetail);
		} else {
			throw new Error(abspath + " not opened in workspace")
		}
	}

	static fromAbsPath(abspath: string, showFullPathAsDetail?: boolean) {
		var uri = Uri.file(abspath);
		return this.fromUri(uri, showFullPathAsDetail);
	}

	static fromRelativePath(relative_path: string, workspaceFolder: string, showFullPathAsDetail?: boolean) {
		return this.fromAbsPath(path.join(workspaceFolder, relative_path), showFullPathAsDetail);
	}

	private constructor(uri: Uri, relative_path: string, workspaceFolderName: string, showFullPathAsDetail?: boolean) {
		this.label = path.basename(uri.fsPath) + " (" + relative_path + ")";
		this.description = workspaceFolderName;
		this.uri = uri;
		this.detail = showFullPathAsDetail ? uri.fsPath : "";
	}
}

class MessageItem implements QuickPickItem {
	label: string;
	description: string;
	alwaysShow = true;

	constructor(title: string, message: string) {
		this.label = title;
		this.description = message;
	}
}

const NOT_MATCHED = -1;
const BASE_NAME_MATCHED = 0;
const BASE_NAME_FUZZY_MATCHED = 1;
const DIR_PATH_MATCHED = 2;
const PATH_MATCHED = 3;

function checkIfPatternMatch(pattern: string/* lower case */, file: string, workpaceFolderPath: string) {
	var basename = path.basename(file).toLowerCase();
	if (basename.includes(pattern)) return BASE_NAME_MATCHED;
	if (fuzzy_match_simple(pattern, basename)) return BASE_NAME_FUZZY_MATCHED;

	var relativePath = file.replace(workpaceFolderPath, "").toLowerCase();
	if (relativePath.includes(pattern)) return DIR_PATH_MATCHED;

	if (file.toLowerCase().includes(pattern.toLowerCase())) return PATH_MATCHED;

	return NOT_MATCHED;
}

async function showSearchResults(input: QuickPick<FileItem | MessageItem>, value: string) {
	input.items = [];
	if (!value) {
		showRentlyFiles(input);
		return;
	}

	input.busy = true;
	await findCandidates(input, value);
	input.busy = false;
}

// todo: support showing icons of different file types
async function findCandidates(input: QuickPick<FileItem | MessageItem>, pattern: string) {
	console.time("filepicker#prepareCandidates");
	for (const workspaceFolder of getWorkspaceFolders()) {
		// 1. relative path, e.g ./hello/world.h
		// 2. absolute path  e.g. /project/hello/world.h
		let thisPattern =
			pattern.startsWith("./") ? pattern = pattern.substring(2) : pattern;
		await findCandidatesInWorkspaceFolder(thisPattern.toLowerCase(), workspaceFolder, input);
	}
	console.timeEnd("filepicker#prepareCandidates");
}

async function findCandidatesInWorkspaceFolder(pattern: string, workspaceFolder: string,
	input: QuickPick<MessageItem | FileItem>) {
	log("filepicker: #prepareCandidates, pattern: " + pattern + ", workspace folder: " + workspaceFolder);
	var fileList = await getFileListOfWorkspaceFolder(workspaceFolder);
	// input.items = (await getRecentlyOpenedFileList())
	// 	.filter(file => isPatternMatch(pattern, file))
	// 	.map(file => FileItem.fromUri(Uri.file(file)));
	if (fileList.length == 0) {
		input.items = input.items.concat([
			new MessageItem("Did you forget building search database?",
				"please run `FilePicker: Build Search Database`")
		]);
		log("filepicker: no available cache, perhaps you forgot to build it?");
		return;
	}

	var results: (FileItem | MessageItem)[] = [];
	var fuzzyMatchedResults: (FileItem | MessageItem)[] = []
	fileList.some((file, index) => {
		// todo: paging?
		if (input.items.length >= 300) {
			log("filepicker: too many search results for pattern:" + pattern + ", please narrow down the pattern");
			return true; // abort the Array.some() loop
		}

		const matched = checkIfPatternMatch(pattern, file, workspaceFolder);
		if (matched == NOT_MATCHED) {
			return false;
		}

		if (matched == BASE_NAME_FUZZY_MATCHED && fuzzyMatchedResults.length < 100) {
			fuzzyMatchedResults.push(FileItem.fromAbsPath(file));
			return false;
		}

		results.push(FileItem.fromAbsPath(file, matched == PATH_MATCHED));

		// don't keep the user waiting, show the results that we already have found
		if (results.length >= 25) {
			input.items = input.items.concat(results);
			results = [];
		}
		return false;
	});
	input.items = input.items.concat(results.concat(fuzzyMatchedResults));
	if (input.items.length == 0) {
		log("filepicker:  no matching result for pattern: " + pattern);
		results.push(new MessageItem("Opps, no matching result", ""));
	} else {
		log("filepicker: found " + input.items.length + " matched results");
	}
}

async function pickFile() {
	const disposables: Disposable[] = [];
	try {
		return await new Promise<Uri | undefined>((resolve, reject) => {
			const input = window.createQuickPick<FileItem | MessageItem>();
			input.matchOnDescription = true;
			input.matchOnDetail = true;
			const timeoutObjs: any[] = []
			input.placeholder = 'FilePicker: Type To Search For Files';
			showRentlyFiles(input);
			disposables.push(
				input.onDidChangeValue(key => {
					if (timeoutObjs.length > 0) {
						log("filepicker: input changed too frequently, cancel previous query");
						clearTimeout(timeoutObjs[0]);
						timeoutObjs.length = 0;
					}
					const pattern = key;
					const timeoutObj = setTimeout(showSearchResults, 200, input, pattern);
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

async function showRentlyFiles(input: QuickPick<FileItem | MessageItem>) {
	input.items = (await getRecentlyOpenedFileList()).map((abs_path) => FileItem.fromAbsPath(abs_path));
}
