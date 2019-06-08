import * as vscode from 'vscode';
import { quickOpen } from './quickOpen';
import { buildSearchDatabase, cancelExcludeDirs, addExcludeDirs } from './fileIndexing'
import { commands, ExtensionContext } from 'vscode';
import { initRecentFileHistory } from './recentFileHistory'
import { getWorkspaceFolder, log, setLogLevel } from "./constants";

let isBuildingSearchDatabase: boolean = false;

export function activate(context: ExtensionContext) {
	const workspaceDir = getWorkspaceFolder();
	setLogLevel(vscode.workspace.getConfiguration("FilePicker")
		.get("showDebugLog", "None"));
	log("filepicker: activated for " + workspaceDir);
	vscode.workspace.onDidChangeConfiguration((e) => {
		setLogLevel(vscode.workspace.getConfiguration("FilePicker")
			.get("showDebugLog", "None"));
	});
	initRecentFileHistory();

	context.subscriptions.push(commands.registerCommand('wwm.quickInput', async () => {
		quickOpen();
	}));
	context.subscriptions.push(commands.registerCommand('wwm.buildFileList', async () => {
		if (isBuildingSearchDatabase) {
			vscode.window.showInformationMessage("Busy now, please try it later");
			return;
		}
		isBuildingSearchDatabase = true;
		// update status bar every 100 millis
		await buildSearchDatabase().catch((err) => {
			isBuildingSearchDatabase = false;
			log("filepicker: failed to build file list database, " + err);
		});
		vscode.window.showInformationMessage("Search database created!");
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

