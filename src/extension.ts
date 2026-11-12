import * as vscode from 'vscode';
import { commands, ExtensionContext, ProgressLocation } from 'vscode';
import { quickOpen } from './quickOpen';
import { buildSearchDatabase, cancelExcludeDirs, addExcludeDirs } from './fileIndexing';
import { initRecentFileHistory } from './recentFileHistory';
import { setLogLevel, log } from './logger';
import { getWorkspaceFolder } from './paths';

let isBuildingSearchDatabase = false;

export function activate(context: ExtensionContext) {
    log("activated for " + getWorkspaceFolder());
    applyLogLevel();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(applyLogLevel));
    initRecentFileHistory();

    context.subscriptions.push(commands.registerCommand('wwm.quickInput', async () => {
        await quickOpen();
    }));

    context.subscriptions.push(commands.registerCommand('wwm.buildFileList', async () => {
        if (isBuildingSearchDatabase) {
            vscode.window.showInformationMessage("Busy now, please try it later");
            return;
        }
        isBuildingSearchDatabase = true;
        try {
            await vscode.window.withProgress({
                location: ProgressLocation.Notification,
                title: "FilePicker: building search database...",
            }, (progress) => buildSearchDatabase(
                count => progress.report({ message: count + " files indexed" })));
            vscode.window.showInformationMessage("FilePicker: search database created!");
        } catch (err) {
            log("failed to build search database, " + err);
            vscode.window.showErrorMessage("FilePicker: failed to build search database: " + err);
        } finally {
            isBuildingSearchDatabase = false;
        }
    }));

    context.subscriptions.push(commands.registerCommand('wwm.cancelExcludeDir',
        async (mainUri?: vscode.Uri, allUris?: vscode.Uri[]) => {
            await runWithProgress("FilePicker: re-indexing un-excluded dirs...",
                onProgress => cancelExcludeDirs(mapUrisToFilePathes(allUris, mainUri), onProgress));
        }));

    context.subscriptions.push(commands.registerCommand('wwm.excludeDir',
        async (mainUri?: vscode.Uri, allUris?: vscode.Uri[]) => {
            await runWithProgress("FilePicker: excluding dirs...",
                onProgress => addExcludeDirs(mapUrisToFilePathes(allUris, mainUri), onProgress));
        }));
}

function applyLogLevel() {
    setLogLevel(vscode.workspace.getConfiguration("FilePicker").get("showDebugLog", "None"));
}

async function runWithProgress(title: string,
    task: (onProgress: (count: number) => void) => Promise<void>) {
    try {
        await vscode.window.withProgress({
            location: ProgressLocation.Notification,
            title,
        }, (progress) => task(count => progress.report({ message: count + " files indexed" })));
    } catch (err) {
        log("operation failed: " + err);
        vscode.window.showErrorMessage("FilePicker: " + err);
    }
}

function mapUrisToFilePathes(allUris: vscode.Uri[] | undefined, mainUri: vscode.Uri | undefined): string[] {
    const dirs: string[] = [];
    for (const uri of Array.isArray(allUris) ? allUris : [mainUri]) {
        if (uri instanceof vscode.Uri) {
            dirs.push(uri.fsPath);
        }
    }
    return dirs;
}
