// Self tests for the pure (vscode-free) modules. Run with: npm test

import * as assert from 'assert';
import { buildShortName, makeIndexedFile } from '../indexedFile';
import {
    buildTrigramIndex, lookupCandidates, hashPaths, serializeTrigramIndex, deserializeTrigramIndex,
} from '../trigramIndex';
import { MatchKind, compilePattern, findMatches, matchFile } from '../search';

let failures = 0;

function test(name: string, fn: () => void | Promise<void>) {
    return Promise.resolve().then(fn).then(
        () => console.log("PASS " + name),
        (err) => {
            failures++;
            console.error("FAIL " + name + ": " + err);
        });
}

function matchKind(patternText: string, absPath: string): MatchKind {
    return matchFile(compilePattern(patternText), makeIndexedFile(absPath));
}

async function main() {
    await test("buildShortName", () => {
        assert.strictEqual(buildShortName("ActivityManagerService.java"), "ams.java");
        assert.strictEqual(buildShortName("helloWorld.txt"), "hw.txt");
        assert.strictEqual(buildShortName("foo_bar_baz.c"), "fbb.c");
        assert.strictEqual(buildShortName("foo_bar.c"), "fb.c");
        assert.strictEqual(buildShortName("my-file.h"), "mf.h");
        assert.strictEqual(buildShortName("README.md"), "readme.md");
        assert.strictEqual(buildShortName("main.c"), "m.c");
    });

    await test("makeIndexedFile", () => {
        const f = makeIndexedFile("/ws/src/FooBar.cpp");
        assert.strictEqual(f.path, "/ws/src/FooBar.cpp");
        assert.strictEqual(f.basenameLower, "foobar.cpp");
        assert.strictEqual(f.shortName, "fb.cpp");
    });

    await test("matchFile ranking", () => {
        assert.strictEqual(matchKind("main", "/ws/main.c"), MatchKind.Exact);
        assert.strictEqual(matchKind("main", "/ws/MainActivity.java"), MatchKind.Prefix);
        assert.strictEqual(matchKind("ain", "/ws/main.c"), MatchKind.Substring);
        assert.strictEqual(matchKind("bb", "/ws/src/foo/BarBaz.cpp"), MatchKind.Acronym);
        assert.strictEqual(matchKind("src/foo", "/ws/src/foo/BarBaz.cpp"), MatchKind.Path);
        assert.strictEqual(matchKind("main", "/ws/src/foo/BarBaz.cpp"), MatchKind.None);
        // leading "./" is stripped
        assert.strictEqual(matchKind("./src/foo", "/ws/src/foo/BarBaz.cpp"), MatchKind.Path);
        // terms match case-insensitively
        assert.strictEqual(matchKind("MAIN", "/ws/main.c"), MatchKind.Exact);
    });

    await test("matchFile multi-term AND", () => {
        // terms match the name (basename/shortName), path segments ('/' terms
        // match the path), all terms must match
        assert.strictEqual(matchKind("foo main", "/ws/foo_main.c"), MatchKind.Substring);
        assert.strictEqual(matchKind("foo main", "/ws/src/foo/main.c"), MatchKind.Path);
        assert.strictEqual(matchKind("src/foo main", "/ws/src/foo/main.c"), MatchKind.Path);
        assert.strictEqual(matchKind("foo missing", "/ws/foo_main.c"), MatchKind.None);
        // weakest term decides the rank
        assert.strictEqual(matchKind("ain main", "/ws/main.c"), MatchKind.Substring);
    });

    await test("matchFile path segment fallback", () => {
        // plain terms also match directory names (prefix match on segments)
        assert.strictEqual(matchKind("foo", "/ws/src/foo/main.c"), MatchKind.Path);
        assert.strictEqual(matchKind("fo", "/ws/src/foo/main.c"), MatchKind.Path);
        assert.strictEqual(matchKind("src foo", "/ws/src/foo/main.c"), MatchKind.Path);
        assert.strictEqual(matchKind("mysrc", "/ws/src/foo/main.c"), MatchKind.None);
        assert.strictEqual(matchKind("oo", "/ws/src/foo/main.c"), MatchKind.None); // not a segment prefix
    });

    await test("negation and extension filters", () => {
        assert.strictEqual(matchKind("main !test", "/ws/main.c"), MatchKind.Exact);
        assert.strictEqual(matchKind("main !test", "/ws/main_test.c"), MatchKind.None);
        assert.strictEqual(matchKind("main .java", "/ws/Main.java"), MatchKind.Exact);
        assert.strictEqual(matchKind("main .java", "/ws/main.c"), MatchKind.None);
        assert.strictEqual(matchKind("main !.java", "/ws/main.c"), MatchKind.Exact);
        assert.strictEqual(matchKind("main !.java", "/ws/main.java"), MatchKind.None);
        // a lone extension-looking term is a plain name search
        assert.strictEqual(matchKind(".txt", "/ws/foo.txt"), MatchKind.Substring);
        // negation-only query matches everything else
        assert.strictEqual(matchKind("!test", "/ws/main.c"), MatchKind.Path);
        assert.strictEqual(matchKind("!test", "/ws/main_test.c"), MatchKind.None);
    });

    await test("trigram candidates cover all true matches", () => {
        const names = [
            "/ws/ActivityManagerService.java",
            "/ws/src/activity_manager_impl.cpp",
            "/ws/main.c",
            "/ws/foo/BarBaz.cpp",
            "/ws/tests/manager_test.cc",
        ];
        const files = names.map(makeIndexedFile);
        const index = buildTrigramIndex(files);
        for (const pattern of ["manager", "act", "barbaz", "zzzxyz", "test", "a"]) {
            const pattern_ = compilePattern(pattern);
            const candidates = lookupCandidates(index, pattern_.terms);
            if (pattern_.terms.some(t => t.length < 3)) {
                assert.strictEqual(candidates, null, pattern + " should require full scan");
                continue;
            }
            assert.ok(candidates !== null, pattern + " should use the index");
            const got = new Set(Array.from(candidates!));
            for (let i = 0; i < files.length; i++) {
                const isTrueMatch = matchKind(pattern, files[i].path) !== MatchKind.None;
                if (isTrueMatch) {
                    assert.ok(got.has(i), "missing candidate: " + files[i].path + " for " + pattern);
                }
            }
            if (pattern === "zzzxyz") {
                assert.strictEqual(candidates!.length, 0, "no match expected");
            }
        }
    });

    await test("trigram multi-term intersection", () => {
        const files = ["/ws/foobar.c", "/ws/foobaz.c", "/ws/zzz.c"].map(makeIndexedFile);
        const index = buildTrigramIndex(files);
        const candidates = lookupCandidates(index, ["foo", "bar"]);
        assert.deepStrictEqual(Array.from(candidates!), [0]);
    });

    await test("findMatches ranks exact matches first", async () => {
        const files = ["/ws/a/mainx.c", "/ws/main.c", "/ws/src/main.c"].map(makeIndexedFile);
        const result = await findMatches(files, compilePattern("main"), {});
        assert.ok(result !== null);
        const paths = result!.matches.map(m => files[m.fileIdx].path);
        assert.deepStrictEqual(paths, ["/ws/main.c", "/ws/src/main.c", "/ws/a/mainx.c"]);
        assert.strictEqual(result!.matches[0].kind, MatchKind.Exact);
        assert.strictEqual(result!.matches[2].kind, MatchKind.Prefix);
    });

    await test("findMatches ranks acronym above substring", async () => {
        // "ams" is the acronym of ActivityManagerService; incidental substring
        // hits like cams.h must not outrank it.
        const files = [
            "/ws/cams.h",
            "/ws/Streams.h",
            "/ws/AmScoHelperTest.kt",
            "/ws/src/ActivityManagerService.java",
        ].map(makeIndexedFile);
        const r = await findMatches(files, compilePattern("ams"), {});
        assert.ok(r !== null);
        const paths = r!.matches.map(m => files[m.fileIdx].path);
        assert.ok(paths.indexOf("/ws/src/ActivityManagerService.java") < paths.indexOf("/ws/cams.h"),
            "acronym match should outrank substring match: " + paths.join(", "));
    });

    await test("findMatches honors limit and reports truncation", async () => {
        const files: string[] = [];
        for (let i = 0; i < 50; i++) {
            files.push("/ws/file" + i + "_match.c");
        }
        const indexed = files.map(makeIndexedFile);
        const result = await findMatches(indexed, compilePattern("match"), { limit: 10 });
        assert.ok(result !== null);
        assert.strictEqual(result!.matches.length, 10);
        assert.strictEqual(result!.truncated, true);
    });

    await test("findMatches aborts when cancelled", async () => {
        const files = ["/ws/a.c", "/ws/b.c", "/ws/c.c"].map(makeIndexedFile);
        const result = await findMatches(files, compilePattern("c"),
            { yieldEvery: 1, isCancelled: () => true });
        assert.strictEqual(result, null);
    });

    await test("fuzzy subsequence matches", async () => {
        const files = [
            "/ws/ActivityManagerService.java",
            "/ws/hello_world.cpp",
            "/ws/main.c",
        ].map(makeIndexedFile);
        const r1 = await findMatches(files, compilePattern("actmgr"), {});
        assert.ok(r1 !== null);
        assert.strictEqual(r1!.matches.length, 1);
        assert.strictEqual(r1!.matches[0].kind, MatchKind.Fuzzy);
        assert.strictEqual(files[r1!.matches[0].fileIdx].path, "/ws/ActivityManagerService.java");

        const r2 = await findMatches(files, compilePattern("hworld"), {});
        assert.ok(r2 !== null && r2!.matches.length === 1);
        assert.strictEqual(r2!.matches[0].kind, MatchKind.Fuzzy);
        assert.strictEqual(files[r2!.matches[0].fileIdx].path, "/ws/hello_world.cpp");
    });

    await test("fuzzy pass is skipped when strict matches are plentiful", async () => {
        const paths: string[] = [];
        for (let i = 0; i < 20; i++) {
            paths.push("/ws/main" + i + ".c");
        }
        paths.push("/ws/ActivityManagerService.java");
        const files = paths.map(makeIndexedFile);
        const r = await findMatches(files, compilePattern("main"), { fuzzyThreshold: 10 });
        assert.ok(r !== null);
        assert.ok(r!.matches.length >= 20);
        for (const m of r!.matches) {
            assert.notStrictEqual(m.kind, MatchKind.Fuzzy);
        }
        // <= 0 disables the fuzzy pass entirely
        const r2 = await findMatches(files, compilePattern("actmgr"), { fuzzyThreshold: 0 });
        assert.ok(r2 !== null);
        assert.strictEqual(r2!.matches.length, 0);
    });

    await test("recently opened files rank first", async () => {
        const files = ["/ws/src/main.c", "/ws/main.c"].map(makeIndexedFile);
        const rankBoost = (p: string) => p === "/ws/src/main.c" ? 10 : 0;
        const r = await findMatches(files, compilePattern("main"), { rankBoost });
        assert.ok(r !== null);
        assert.strictEqual(files[r!.matches[0].fileIdx].path, "/ws/src/main.c");
    });

    await test("trigram index serialization round trip", () => {
        const files = [
            "/ws/src/FooBar.cpp",
            "/ws/main.c",
            "/ws/a/b/ActivityManagerService.java",
        ].map(makeIndexedFile);
        const index = buildTrigramIndex(files);
        const hash = hashPaths(files.map(f => f.path));
        const buf = serializeTrigramIndex(index, hash);
        const restored = deserializeTrigramIndex(buf, hash);
        assert.ok(restored !== null);
        assert.strictEqual(restored!.fileCount, index.fileCount);
        for (const pattern of ["foobar", "ams", "src", "main", "fb"]) {
            const terms = compilePattern(pattern).terms;
            const expected = lookupCandidates(index, terms);
            const got = lookupCandidates(restored!, terms);
            if (expected === null) {
                assert.strictEqual(got, null, pattern);
            } else {
                assert.deepStrictEqual(Array.from(got!), Array.from(expected!), pattern);
            }
        }
        // stale or corrupt caches are rejected
        assert.strictEqual(deserializeTrigramIndex(buf, hash + 1), null);
        assert.strictEqual(deserializeTrigramIndex(buf.slice(0, 10), hash), null);
    });

    if (failures > 0) {
        console.error(failures + " test(s) failed");
        process.exit(1);
    }
    console.log("all tests passed");
}

main();
