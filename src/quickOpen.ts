import * as path from 'path';
import { Uri, window, Disposable, QuickPickItem, workspace, QuickPick } from 'vscode';
import { getWorkspaceDir, fuzzy_match_simple, log } from "./constants";
import { loadSearchDatabaseAsync } from './fileIndexing';
import { getRecentlyOpenedFileList } from './recentFileHistory'

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

class FileItem implements QuickPickItem {
	label: string;
	description: string;

	constructor(public base: Uri, public uri: Uri) {
		this.label = path.basename(uri.fsPath);
		this.description = uri.fsPath;
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

function isPatternMatch(pattern: string, file: string) {
	var matched = file.toLowerCase().includes(pattern.toLocaleLowerCase());
	return matched || fuzzy_match_simple(pattern, path.basename(file));
}

async function queryCandidates(input: QuickPick<FileItem | MessageItem>, value: string) {
	input.items = [];
	if (!value) {
		showRentlyFiles(input);
		return;
	}

	input.busy = true;
	console.time("filepicker_queryCandidates");
	console.time("filepicker_loadSearchDatabase");
	var lines = await loadSearchDatabaseAsync();
	console.timeEnd("filepicker_loadSearchDatabase");
	prepareCandidates(input, lines, value);
	input.busy = false;
	console.timeEnd("filepicker_queryCandidates");
}

// todo: support showing icons of different file types
function prepareCandidates(input: QuickPick<FileItem | MessageItem>, lines: string[], pattern: string) {
	console.time("filepicker: #prepareCandidates");
	var workspaceFolder = getWorkspaceDir();
	// absolute path?
	if (pattern.startsWith("/")) {
		pattern = pattern.replace(workspaceFolder, ".")
	}
	log("filepicker: #prepareCandidates, pattern=" + pattern);
	if (lines.length == 0) {
		input.items = [
			new MessageItem("Did you forget building search database?", "please run `FilePicker: Build Search Database`")
		];
		log("filepicker: no available cache, perhaps you forgot to build it?");
	} else {
		const results: (FileItem | MessageItem)[] = [];
		lines.some((file) => {
			// todo: paging?
			if (results.length >= 500) {
				log("filepicker: too many search results, please narrow down the pattern")
				return true; // abort the forEach loop
			}
			if (isPatternMatch(pattern, file)) {
				results.push(new FileItem(Uri.file(workspaceFolder), Uri.file(path.join(workspaceFolder, file))));
			}
			return false;
		});
		input.items = results;
	}
	console.timeEnd("filepicker: #prepareCandidates");
}

async function pickFile() {
	const disposables: Disposable[] = [];
	try {
		return await new Promise<Uri | undefined>((resolve, reject) => {
			const input = window.createQuickPick<FileItem | MessageItem>();
			input.matchOnDescription = true;
			// input.matchOnDetail = true;
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

function showRentlyFiles(input: QuickPick<FileItem | MessageItem>) {
	const workspaceFolder = getWorkspaceDir();
	input.items = [...getRecentlyOpenedFileList().map(
		(relative_path) => new FileItem(Uri.file(workspaceFolder), Uri.file(path.join(workspaceFolder, relative_path))))];
}
