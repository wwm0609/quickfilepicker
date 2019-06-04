import * as path from 'path';
import { Uri, window, Disposable, QuickPickItem, workspace, QuickPick } from 'vscode';
import { getWorkspaceDir, fuzzy_match_simple } from "./constants";
import { getFileList } from './fileIndexing';


/**
 * A file opener using window.createQuickPick().
 * 
 * It shows how the list of items can be dynamically updated based on
 * the user's input in the filter field.
 */
export async function quickOpen(recentlyOpenedFiles: string[]) {
	const uri = await pickFile(recentlyOpenedFiles);
	if (uri) {
		const document = await workspace.openTextDocument(uri);
		await window.showTextDocument(document);
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
	return matched || fuzzy_match_simple(pattern, path.basename(file));
}

async function queryCandidates(input: QuickPick<FileItem | MessageItem>, value: string) {
	console.log("filepicker: #queryCandidates, pattern=" + value);
	input.items = [];
	if (!value) {
		return;
	}
	input.busy = true;
	console.time("filepicker: queryCandidates");
	console.time("filepicker: getFileList");
	var lines = await getFileList();
	console.timeEnd("filepicker: getFileList");
	var result = prepareCandidates(input, lines, value);
	input.busy = false;
	console.timeEnd("filepicker: queryCandidates");
	return result;
}

function prepareCandidates(input: QuickPick<FileItem | MessageItem>, lines: string[], value: string) {
	console.time("filepicker: prepareCandidates");
	if (lines.length == 0) {
		console.timeEnd("filepicker: #queryCandidates, no available cache, please built it first");
	} else {
		var workspaceFolder = getWorkspaceDir();
		input.items = input.items.concat(lines.filter(function (element) {
			return isPatternMatch(value, element);
		}).map(file => new FileItem(Uri.file(workspaceFolder), Uri.file(path.join(workspaceFolder, file)))));
	}
	console.timeEnd("filepicker: prepareCandidates");
}

async function pickFile(recentlyOpenedFiles: string[]) {
	const disposables: Disposable[] = [];
	try {
		return await new Promise<Uri | undefined>((resolve, reject) => {
			const input = window.createQuickPick<FileItem | MessageItem>();
			const timeoutObjs: any[] = []
			input.placeholder = 'filepicker: type to search for files';
			var workspaceFolder = getWorkspaceDir();
			input.items = input.items.concat(recentlyOpenedFiles.map((relative_path) => new FileItem(Uri.file(workspaceFolder), Uri.file(path.join(workspaceFolder, relative_path)))));
			disposables.push(
				input.onDidChangeValue(key => {
					if (timeoutObjs.length > 0) {
						console.log("filepicker: cancel previous query");
						clearTimeout(timeoutObjs[0]);
						timeoutObjs.length = 0;
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