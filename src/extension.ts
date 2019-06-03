/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { quickOpen, buildFileListCache } from './quickOpen';
import { commands, ExtensionContext, workspace } from 'vscode';
import * as vscode from 'vscode';
import * as path from 'path';

let myStatusBarItem: vscode.StatusBarItem;
let isBuildingFileList:boolean = false;
myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

export function activate(context: ExtensionContext) {
	const cwds = workspace.workspaceFolders ?
		workspace.workspaceFolders.map(f => f.uri.fsPath) : [process.cwd()];
	const workspaceDir = cwds[0];
	console.log("FastFilePicker: activated for " + workspaceDir);
	context.subscriptions.push(commands.registerCommand('wwm.quickInput', async () => {
		console.log("damn vscode2");
		quickOpen();
	}));
	context.subscriptions.push(commands.registerCommand('wwm.buildFileList', async () => {
		if (isBuildingFileList) {
			vscode.window.showInformationMessage("fast picker: busy now, please try later");
			return;
		}
		isBuildingFileList = true;
		console.log("damn vscode1");
		myStatusBarItem.text = `filepicker: indexing...`;
		myStatusBarItem.show();
		// const configuration = vscode.workspace.getConfiguration();
		// const currentValue = configuration.get('conf.resource.insertEmptyLastLine');
		// todo: read exclude dirs from configuration
		var excludeDirs = ["out", 'test', 'vendor', 'cts', 'tools', 'src/tools', ".repo", "node_modules"]
			.map(folder => path.join(workspaceDir, folder));
		// var excludeFilePatterns:string[] = []
		var count = 0;
		const intervalObj = setInterval(function() {
			myStatusBarItem.text = `filepicker: ` + count
		}, 100)
		buildFileListCache(workspaceDir, excludeDirs, () => {
			++count
		}).then(database => {
			isBuildingFileList = false;
			clearInterval(intervalObj);
			myStatusBarItem.hide();
			vscode.window.showInformationMessage("fast picker: indexing finished, see " + database);
		}).catch((err) => {
			isBuildingFileList = false;
			console.log("failed to build file list database", err);
		});
	}));
}
