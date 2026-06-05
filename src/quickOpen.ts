import * as path from 'path';
import { Uri, window, Disposable, QuickPickItem, workspace, QuickPick } from 'vscode';
import { getWorkspaceFolders, log, isUnixLikeSystem, logw, logd } from "./constants";
import { getFileListOfWorkspaceFolder, IndexedFile, lookupTrigramCandidates } from './fileIndexing';
import { getRecentlyOpenedFileList, removeFileFromHistory } from './recentFileHistory'
import * as vscode from 'vscode';
import * as fs from 'fs';

/**
 * A file opener using window.createQuickPick().
 * 
 * It shows how the list of items can be dynamically updated based on
 * the user's input in the filter field.
 */
export async function quickOpen() {
	const uri = await pickFile();
	if (uri) {
		log("opening " + uri);
		await workspace.openTextDocument(uri).then((value) => {
			// open the new file beside the active tab
			window.showTextDocument(value);
		}, (reason) => {
			log("failed to open " + uri + ", error=" + reason);
			fs.exists(uri.fsPath, (exists) => {
				if (!exists) {
					removeFileFromHistory(uri.fsPath);
					return;
				}
				// "_files.windowOpen" seems to be private;
				// use explorer.openToSide to open a none text file
				vscode.commands.executeCommand("explorer.openToSide", uri);
			});
		});
	}
}

class FileItem implements QuickPickItem {
	label: string;
	description: string;
	detail: string;
	uri: Uri;
	alwaysShow: boolean

	toString() {
		return this.label + ": " + this.description;
	}

	static fromUri(uri: Uri, showFullPathAsDetail?: boolean, ) {
		var abspath = uri.fsPath;
		var workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
		if (!workspaceFolder) {
			logw("" + abspath + " not opened in workspace")
		}
		var prefix = isUnixLikeSystem() ? "./" : ""; // if on unix like systems
		var relativePath = prefix + vscode.workspace.asRelativePath(abspath);
		return new FileItem(uri, relativePath, showFullPathAsDetail);
	}

	static fromAbsPath(abspath: string, showFullPathAsDetail?: boolean) {
		var uri = Uri.file(abspath);
		return this.fromUri(uri, showFullPathAsDetail);
	}

	static fromRelativePath(relative_path: string, workspaceFolder: string, showFullPathAsDetail?: boolean) {
		return this.fromAbsPath(path.join(workspaceFolder, relative_path), showFullPathAsDetail);
	}

	private constructor(uri: Uri, relative_path: string, showFullPathAsDetail?: boolean) {
		// show file icon? but no api available yet
		this.label = path.basename(uri.fsPath);
		this.description = relative_path;
		this.uri = uri;
		this.detail = showFullPathAsDetail ? uri.fsPath : "";
		this.alwaysShow = false
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

	toString() {
		return this.label + ": " + this.description;
	}
}

const NOT_MATCHED = -1;
const BASE_NAME_MATCHED = 0;
const SHORT_BASE_NAME_MATCHED = 1;

// Monotonic counter; every new keystroke bumps it. Search loops compare their
// captured value against the live counter at yield points and abort early when
// they no longer represent the latest input.
let activeSearchSeq = 0;
const YIELD_EVERY = 2000;

function yieldToEventLoop() {
	return new Promise<void>(resolve => setImmediate(resolve));
}

function checkIfPatternMatch(pattern: string, patternInLowerCase: string/* lower case */, file: IndexedFile, workpaceFolderPath: string) {
	if (file.basenameLower.includes(patternInLowerCase)) {
		return BASE_NAME_MATCHED;
	}
	if (file.shortName.startsWith(patternInLowerCase)) {
		return SHORT_BASE_NAME_MATCHED;
	}
	if (isUnixLikeSystem()) {
		if (pattern.includes("/") && file.path.includes(pattern))
			return BASE_NAME_MATCHED;
	}
	return NOT_MATCHED;
}

async function showSearchResults(input: QuickPick<FileItem | MessageItem>, value: string, seq: number) {
	input.items = [];
	if (!value) {
		showRentlyFiles(input);
		return;
	}

	input.busy = true;
	await findCandidates(input, value, seq);
	if (seq === activeSearchSeq) {
		input.busy = false;
	}
}

// todo: support showing icons of different file types
async function findCandidates(input: QuickPick<FileItem | MessageItem>, pattern: string, seq: number) {
	// 1. relative path, e.g ./hello/world.h
	// 2. absolute path  e.g. /project/hello/world.h
	let thisPattern =
		pattern.startsWith("./") ? pattern = pattern.substring(2) : pattern;
	let workspaces = getWorkspaceFolders();
	return Promise.all(workspaces.map(workspaceFolder => {
		return findCandidatesInWorkspaceFolder(thisPattern, workspaceFolder, input, workspaces.length > 1, seq)
	}));
}

async function findCandidatesInWorkspaceFolder(pattern: string, workspaceFolder: string,
	input: QuickPick<MessageItem | FileItem>, multipleWorkspaces: boolean, seq: number) {
	log("#prepareCandidates, pattern: " + pattern + ", workspace folder: " + workspaceFolder);

	var abs_file_path = path.join(workspaceFolder, pattern);
	if (fs.existsSync(abs_file_path)) {
		if (seq !== activeSearchSeq) return;
		var item = FileItem.fromAbsPath(abs_file_path, multipleWorkspaces);
		input.items = [item];
		return;
	}

	var fileList = await getFileListOfWorkspaceFolder(workspaceFolder);
	if (seq !== activeSearchSeq) return;
	if (fileList.length == 0) {
		input.items = input.items.concat([
			new MessageItem("Did you forget building search database?",
				"please run `Build Search Database`")
		]);
		log("no available cache, perhaps you forgot to build it?");
		return;
	}
	console.time("filepicker#findCandidatesInWorkspaceFolder");

	var results: (FileItem | MessageItem)[] = [];
	var fuzzyMatchedResults: (FileItem | MessageItem)[] = []
	var patternInLowerCase = pattern.toLowerCase()

	// Pick the iteration source: trigram candidates when usable, else full scan.
	// The basename trigram index can't represent matches that only appear in the
	// path portion, so patterns containing '/' fall back to the full scan.
	let candidates: Uint32Array | null = null;
	if (patternInLowerCase.length >= 3 && pattern.indexOf("/") < 0) {
		candidates = lookupTrigramCandidates(workspaceFolder, patternInLowerCase);
	}
	const useCandidates = candidates !== null;
	const total = useCandidates ? candidates!.length : fileList.length;
	if (useCandidates) {
		log("trigram candidates: " + total + " (pattern=" + pattern + ")");
	}

	for (var i = 0; i < total; i++) {
		// Yield to the event loop periodically and bail out if a newer search
		// has started in the meantime.
		if (i > 0 && (i % YIELD_EVERY) == 0) {
			await yieldToEventLoop();
			if (seq !== activeSearchSeq) {
				log("search canceled for pattern: " + pattern);
				console.timeEnd("filepicker#findCandidatesInWorkspaceFolder");
				return;
			}
		}

		// todo: paging?
		if (input.items.length >= 300) {
			log("too many search results for pattern:" + pattern + ", please narrow down the pattern");
			break;
		}

		const fileIdx = useCandidates ? candidates![i] : i;
		const file = fileList[fileIdx];
		const matched = checkIfPatternMatch(pattern, patternInLowerCase, file, workspaceFolder);
		if (matched == NOT_MATCHED) {
			continue;
		}
		var item = FileItem.fromAbsPath(file.path, multipleWorkspaces);
		item.alwaysShow = matched == SHORT_BASE_NAME_MATCHED;
		results.push(item);
		// Show what we already have found
		if (input.items.length == 0 && results.length >= 10) {
			input.items = (results).concat(fuzzyMatchedResults);
			results = []
			fuzzyMatchedResults = []
			input.busy = false;
		}
		if (results.length >= 100) {
			break;
		}
	}
	if (seq !== activeSearchSeq) {
		console.timeEnd("filepicker#findCandidatesInWorkspaceFolder");
		return;
	}
	// We would like to sort the results, but QuickPickWindow seems have its own sorting, -_-||
	input.items = input.items.concat(results).concat(fuzzyMatchedResults);
	if (input.items.length == 0) {
		logd("no matching result for pattern: " + pattern);
		input.items = input.items.concat(new MessageItem("Opps, nothing matched", ""));
	} else {
		logd("found " + input.items.length + " matching results totaly: " + results.slice(0, 5).join(", ") + " ....");
	}
	console.timeEnd("filepicker#findCandidatesInWorkspaceFolder");
}

async function pickFile() {
	const disposables: Disposable[] = [];
	try {
		return await new Promise<Uri | undefined>((resolve, reject) => {
			const input = window.createQuickPick<FileItem | MessageItem>();
			// input.ignoreFocusOut = true
			input.matchOnDescription = true;
			input.matchOnDetail = true;
			let pendingTimeout: NodeJS.Timeout | undefined;
			input.placeholder = 'Type To Search For Files';
			showRentlyFiles(input);
			disposables.push(
				input.onDidChangeValue(key => {
					// Bump the seq immediately so any in-flight search bails at
					// its next yield point, regardless of the debounce window.
					const seq = ++activeSearchSeq;
					if (pendingTimeout !== undefined) {
						clearTimeout(pendingTimeout);
					}
					pendingTimeout = setTimeout(() => {
						pendingTimeout = undefined;
						showSearchResults(input, key, seq);
					}, 80 /* millis */);
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
