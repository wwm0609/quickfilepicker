"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const vscode_1 = require("vscode");
const quickOpen_1 = require("./quickOpen");
const quickOpen_2 = require("./quickOpen");
const vscode = require("vscode");
function activate(context) {
    console.log("QuickPick: activated");
    context.subscriptions.push(vscode_1.commands.registerCommand('wwm.quickInput', () => __awaiter(this, void 0, void 0, function* () {
        quickOpen_1.quickOpen();
    })));
    context.subscriptions.push(vscode_1.commands.registerCommand('wwm.buildFileList', () => __awaiter(this, void 0, void 0, function* () {
        let myStatusBarItem;
        myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        showStatus(myStatusBarItem);
        quickOpen_2.buildFileListCache();
        vscode.window.showInformationMessage('file list database constructed!');
        hideStatus(myStatusBarItem);
    })));
}
exports.activate = activate;
function showStatus(myStatusBarItem) {
    myStatusBarItem.text = `building file list cache...`;
    myStatusBarItem.show();
}
function hideStatus(myStatusBarItem) {
    myStatusBarItem.hide();
}
//# sourceMappingURL=extension.js.map