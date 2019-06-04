import * as vscode from 'vscode';
import { quickOpen } from './quickOpen';
import { buildFileListCache, cancelExcludeDirs, addExcludeDirs } from './fileIndexing'
import { commands, ExtensionContext } from 'vscode';
import { recentlyOpenedFileList, initRecentFileHistory } from './recentFileHistory'
import { getWorkspaceDir, ensureCacheDirSync } from "./constants";

let isBuildingFileList: boolean = false;

export function activate(context: ExtensionContext) {
	const workspaceDir = getWorkspaceDir();
	console.log("filepicker: activated for " + workspaceDir);
	ensureCacheDirSync();
	initRecentFileHistory();
	context.subscriptions.push(commands.registerCommand('wwm.quickInput', async () => {
		quickOpen(recentlyOpenedFileList);
	}));
	context.subscriptions.push(commands.registerCommand('wwm.buildFileList', async () => {
		if (isBuildingFileList) {
			vscode.window.showInformationMessage("filepicker: busy now, please try it later");
			return;
		}
		const myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		isBuildingFileList = true;
		myStatusBarItem.text = `filepicker: indexing...`;
		myStatusBarItem.show();
		var count = 0;
		// update status bar every 100 millis
		const intervalObj = setInterval(() => myStatusBarItem.text = `filepicker: ` + count, 100)
		var database = await buildFileListCache(() => ++count).catch((err) => {
			isBuildingFileList = false;
			console.log("filepicker: failed to build file list database", err);
		});
		isBuildingFileList = false;
		clearInterval(intervalObj);
		myStatusBarItem.hide();
		vscode.window.showInformationMessage("fastpicker: indexing finished, see " + database);
	}));
	context.subscriptions.push(commands.registerCommand('wwm.cancelExcludeDir', async (args:any[]) => {
		cancelExcludeDirs([]);
	}));
	context.subscriptions.push(commands.registerCommand('wwm.excludeDir', async (args?: vscode.Uri[]) => {
		if (!args) {
			return;
		}
		// var path = ''
		// if (typeof(args) == 'object' && args["scheme"] == "file"]) {
		// 	path = args["fspath"];
		// 	addExcludeDirs([path]);
		// } else {
		// 	console.log("filepicker: unexpected param ", args);
		// }
	}));
}
