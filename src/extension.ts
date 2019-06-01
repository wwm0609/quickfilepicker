/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { commands, ExtensionContext } from 'vscode';
import { quickOpen } from './quickOpen';
import { buildFileListCache } from './quickOpen';
import * as vscode from 'vscode';

export function activate(context: ExtensionContext) {
	console.log("QuickPick: activated");
	context.subscriptions.push(commands.registerCommand('wwm.quickInput', async () => {
		quickOpen();
	}));
	context.subscriptions.push(commands.registerCommand('wwm.buildFileList', async () => {
		let myStatusBarItem: vscode.StatusBarItem;
		myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		showStatus(myStatusBarItem);
		buildFileListCache();
		vscode.window.showInformationMessage('file list database constructed!');
		hideStatus(myStatusBarItem);
	}));
}

function showStatus(myStatusBarItem: vscode.StatusBarItem) {
	myStatusBarItem.text = `building file list cache...`;
	myStatusBarItem.show();
}

function hideStatus(myStatusBarItem: vscode.StatusBarItem) {
	myStatusBarItem.hide()
}
