// The QuickPick UI: takes keystrokes, runs ranked searches and opens the
// picked file. All matching logic lives in search.ts.

import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { Uri, window, Disposable, QuickPickItem, workspace, QuickPick } from 'vscode';
import { log, logd } from './logger';
import { getWorkspaceFolders, isUnixLikeSystem } from './paths';
import { getFileListOfWorkspaceFolder, getTrigramIndex } from './fileIndexing';
import { lookupCandidates } from './trigramIndex';
import { CompiledPattern, MatchKind, compilePattern, findMatches } from './search';
import { getRecentlyOpenedFileList, getRecentFileRanks, removeFileFromHistory } from './recentFileHistory';

const MAX_VISIBLE_ITEMS = 300;
const DEBOUNCE_MILLIS = 80;

/**
 * A file opener using window.createQuickPick().
 *
 * It shows how the list of items can be dynamically updated based on
 * the user's input in the filter field.
 */
export async function quickOpen() {
    const uri = await pickFile();
    if (!uri) {
        return;
    }
    log("opening " + uri.fsPath);
    try {
        const doc = await workspace.openTextDocument(uri);
        await window.showTextDocument(doc);
    } catch (reason) {
        log("failed to open " + uri.fsPath + ", error=" + reason);
        if (!isFile(uri.fsPath)) {
            removeFileFromHistory(uri.fsPath);
            return;
        }
        // "explorer.openToSide" opens non-text files
        vscode.commands.executeCommand("explorer.openToSide", uri);
    }
}

function isFile(absPath: string): boolean {
    try {
        return fs.statSync(absPath).isFile();
    } catch (e) {
        return false;
    }
}

class FileItem implements QuickPickItem {
    label: string;
    description: string;
    detail: string;
    uri: Uri;
    alwaysShow: boolean;

    static fromAbsPath(absPath: string, workspaceFolder?: string, showFullPathAsDetail?: boolean): FileItem {
        const uri = Uri.file(absPath);
        const fromApi = vscode.workspace.getWorkspaceFolder(uri);
        const root = workspaceFolder || (fromApi ? fromApi.uri.fsPath : undefined);
        const relPath = root ? path.relative(root, absPath) : absPath;
        const relDir = path.dirname(relPath);
        let description = relDir === "." ? "" : relDir;
        if (description && isUnixLikeSystem()) {
            description = "./" + description; // if on unix like systems
        }
        return new FileItem(uri, path.basename(absPath), description,
            showFullPathAsDetail ? absPath : "");
    }

    private constructor(uri: Uri, label: string, description: string, detail: string) {
        this.uri = uri;
        this.label = label;
        this.description = description;
        this.detail = detail;
        this.alwaysShow = true;
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

// Monotonic counter; every new keystroke bumps it. Search loops compare their
// captured value against the live counter at yield points and abort early when
// they no longer represent the latest input.
let activeSearchSeq = 0;

async function showSearchResults(input: QuickPick<FileItem | MessageItem>, value: string, seq: number) {
    if (!value) {
        input.items = (await getRecentlyOpenedFileList())
            .map(absPath => FileItem.fromAbsPath(absPath));
        return;
    }
    input.busy = true;
    try {
        await findCandidates(input, value, seq);
    } finally {
        if (seq === activeSearchSeq) {
            input.busy = false;
        }
    }
}

interface RankedItem {
    item: FileItem;
    kind: MatchKind;
    score: number;
    boost: number;
}

function toFileItem(absPath: string, workspaceFolder: string, multipleWorkspaces: boolean,
    pattern: CompiledPattern, kind: MatchKind): FileItem {
    const item = FileItem.fromAbsPath(absPath, workspaceFolder, multipleWorkspaces);
    // VSCode re-filters items with its own fuzzy matcher, which is known to
    // drop valid results; only plain basename substring matches
    // (Substring/Prefix/Exact) are guaranteed to survive it, everything else
    // must opt out of that filter.
    const isBasenameSubstring = kind === MatchKind.Substring
        || kind === MatchKind.Prefix
        || kind === MatchKind.Exact;
    item.alwaysShow = !isBasenameSubstring
        || pattern.hasSlashTerm
        || pattern.terms.length > 1;
    return item;
}

async function findCandidates(input: QuickPick<FileItem | MessageItem>, patternText: string, seq: number) {
    log("#findCandidates, pattern: " + patternText);
    const pattern = compilePattern(patternText);
    const workspaces = getWorkspaceFolders();
    const multipleWorkspaces = workspaces.length > 1;
    const collected: RankedItem[] = [];
    let truncated = false;
    let missingDatabase = false;

    // Recently opened files rank higher within the same match quality.
    const ranks = await getRecentFileRanks();
    const rankBoost = (absPath: string) => {
        const idx = ranks.get(absPath);
        return idx === undefined ? -1 : ranks.size - idx;
    };

    for (const workspaceFolder of workspaces) {
        if (seq !== activeSearchSeq) return;

        // 1. relative path, e.g ./hello/world.h
        // 2. absolute path  e.g. /project/hello/world.h
        // Only plain files take this shortcut: a directory that happens to be
        // named like the pattern is not openable and used to produce a bogus
        // single result that "jumped to another file" when clicked.
        const absPath = path.join(workspaceFolder, pattern.text);
        if (isFile(absPath)) {
            if (seq !== activeSearchSeq) return;
            input.items = [FileItem.fromAbsPath(absPath, workspaceFolder, multipleWorkspaces)];
            return;
        }

        const fileList = await getFileListOfWorkspaceFolder(workspaceFolder);
        if (seq !== activeSearchSeq) return;
        if (fileList.length === 0) {
            missingDatabase = true;
            continue;
        }

        // Use the trigram index for plain terms, fall back to a full scan for
        // path patterns and short terms.
        const candidates = pattern.allPlainTerms
            ? lookupCandidates(getTrigramIndex(workspaceFolder), pattern.terms)
            : null;
        if (candidates !== null) {
            log("trigram candidates: " + candidates.length + " (pattern=" + patternText + ")");
        }

        const result = await findMatches(fileList, pattern, {
            candidates,
            isCancelled: () => seq !== activeSearchSeq,
            rankBoost,
            onFirstMatches: matches => {
                // Show what we already have found
                input.items = matches.map(m => toFileItem(
                    fileList[m.fileIdx].path, workspaceFolder, multipleWorkspaces, pattern, m.kind));
                input.busy = false;
            },
        });
        if (result === null) {
            log("search canceled for pattern: " + patternText);
            return;
        }
        truncated = truncated || result.truncated;
        for (const m of result.matches) {
            collected.push({
                item: toFileItem(fileList[m.fileIdx].path, workspaceFolder,
                    multipleWorkspaces, pattern, m.kind),
                kind: m.kind,
                score: m.score || 0,
                boost: rankBoost(fileList[m.fileIdx].path),
            });
        }
    }
    if (seq !== activeSearchSeq) return;

    // Rank exact/prefix matches above substring/acronym/path matches, then
    // prefer recently opened files and higher fuzzy scores.
    collected.sort((a, b) => (b.kind - a.kind) || (b.boost - a.boost) || (b.score - a.score));
    const top = collected.slice(0, MAX_VISIBLE_ITEMS);
    const items: (FileItem | MessageItem)[] = top.map(r => r.item);
    if (items.length === 0) {
        if (missingDatabase) {
            log("no available cache, perhaps you forgot to build it?");
            items.push(new MessageItem("Did you forget building search database?",
                "please run `Build Search Database`"));
        } else {
            logd("no matching result for pattern: " + patternText);
            items.push(new MessageItem("Oops, nothing matched", ""));
        }
    } else {
        logd("found " + collected.length + " matching results for " + patternText
            + ", showing " + top.length);
    }
    if (truncated) {
        items.push(new MessageItem("Showing first " + items.length + " matches",
            "please narrow down the pattern"));
    }
    input.items = items;
}

async function pickFile() {
    const disposables: Disposable[] = [];
    try {
        return await new Promise<Uri | undefined>((resolve) => {
            const input = window.createQuickPick<FileItem | MessageItem>();
            input.matchOnDescription = true;
            input.matchOnDetail = true;
            let pendingTimeout: NodeJS.Timeout | undefined;
            // Make it obvious this is the extension's own picker, not the
            // built-in VSCode quick open (Ctrl+P).
            input.title = 'Fast File Picker';
            input.placeholder = 'Fast File Picker: search by file name, or by path like src/foo (space = AND)';
            showSearchResults(input, "", 0);
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
                    }, DEBOUNCE_MILLIS);
                }),
                // Open only on genuine user acceptance (Enter or click).
                // onDidChangeSelection is NOT used for this: it also fires when
                // the items list is refreshed programmatically, which used to
                // accept whatever item replaced the row under the cursor -
                // the "clicked one file but jumped to another" bug.
                input.onDidAccept(() => {
                    const item = input.selectedItems[0];
                    if (item instanceof FileItem) {
                        resolve(item.uri);
                        input.hide();
                    }
                }),
                input.onDidHide(() => {
                    // cancel any in-flight search
                    ++activeSearchSeq;
                    if (pendingTimeout !== undefined) {
                        clearTimeout(pendingTimeout);
                    }
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
