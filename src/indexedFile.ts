// Core index entry type plus the derived-name helpers. Pure logic, no vscode
// dependency so it can be unit tested in plain node.

import * as path from 'path';

export interface IndexedFile {
    /** absolute path */
    path: string;
    /** lowercased basename, used for substring/prefix matching */
    basenameLower: string;
    /** CamelCase acronym of the basename (plus extension), e.g. "ams.java" */
    shortName: string;
}

// Builds the "short name" of a file: the lowercase acronym of its stem (first
// character of each word: after '_', '-' and at every uppercase letter),
// keeping the extension.
// e.g. "ActivityManagerService.java" -> "ams.java",
//      "helloWorld.txt" -> "hw.txt",
//      "foo_bar_baz.c" -> "fbb.c".
export function buildShortName(fileName: string): string {
    let result = "";
    let idx = 0;
    while (idx < fileName.length && fileName[idx] !== '.') {
        const ch = fileName[idx];
        const isWordStart = idx === 0
            || fileName[idx - 1] === '_' || fileName[idx - 1] === '-';
        if (isWordStart || (ch >= 'A' && ch <= 'Z')) {
            result += ch.toLowerCase();
        }
        idx++;
    }
    if (result.length === 0) {
        return result;
    }
    return result + (idx < fileName.length ? fileName.substr(idx) : "");
}

export function makeIndexedFile(absPath: string): IndexedFile {
    const basename = path.basename(absPath);
    return {
        path: absPath,
        basenameLower: basename.toLowerCase(),
        shortName: buildShortName(basename),
    };
}
