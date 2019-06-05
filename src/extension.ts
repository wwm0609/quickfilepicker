import * as vscode from 'vscode';
import { quickOpen } from './quickOpen';
import { buildSearchDatabase, cancelExcludeDirs, addExcludeDirs } from './fileIndexing'
import { commands, ExtensionContext } from 'vscode';
import { initRecentFileHistory } from './recentFileHistory'
import { getWorkspaceDir, ensureCacheDirSync } from "./constants";

let isBuildingSearchDatabase: boolean = false;

export function activate(context: ExtensionContext) {
	const workspaceDir = getWorkspaceDir();
	console.log("filepicker: activated for " + workspaceDir);
	ensureCacheDirSync();
	initRecentFileHistory();
	context.subscriptions.push(commands.registerCommand('wwm.quickInput', async () => {
		quickOpen();
	}));
	context.subscriptions.push(commands.registerCommand('wwm.buildFileList', async () => {
		if (isBuildingSearchDatabase) {
			vscode.window.showInformationMessage("filepicker: busy now, please try it later");
			return;
		}
		isBuildingSearchDatabase = true;
		// update status bar every 100 millis
		var database = await buildSearchDatabase().catch((err) => {
			isBuildingSearchDatabase = false;
			console.log("filepicker: failed to build file list database", err);
		});
		vscode.window.showInformationMessage("fastpicker: search database created, see " + database);
		isBuildingSearchDatabase = false;
	}));
	context.subscriptions.push(commands.registerCommand('wwm.cancelExcludeDir',
			async (mainUri?: vscode.Uri, allUris?: vscode.Uri[]) => {
		cancelExcludeDirs(mapUrisToFilePathes(allUris, mainUri));
	}));
	context.subscriptions.push(commands.registerCommand('wwm.excludeDir',
		async (mainUri?: vscode.Uri, allUris?: vscode.Uri[]) => {
		addExcludeDirs(mapUrisToFilePathes(allUris, mainUri));
	}));
}

function mapUrisToFilePathes(allUris: vscode.Uri[] | undefined, mainUri: vscode.Uri | undefined) {
	var dirs: string[] = [];
	for (const uri of Array.isArray(allUris) ? allUris : [mainUri]) {
		if (uri instanceof vscode.Uri) {
			dirs.push(uri.fsPath);
		}
	}
	return dirs;
}

