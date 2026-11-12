// Pattern compilation, matching and ranked search over the file index.
// Pure logic, no vscode dependency so it can be unit tested in plain node.
//
// Query syntax:
//   - a pattern is split on whitespace into terms; EVERY positive term must
//     match (AND semantics), so "foo bar" finds "barfoo.c"
//   - a term without '/' matches the basename (substring) or the CamelCase
//     short name (prefix, e.g. "ams" -> ActivityManagerService.java), and as a
//     fallback any directory segment starting with it (e.g. "src" matches
//     anything under a src/ directory)
//   - a term containing '/' matches the absolute path (substring), so
//     "src/foo" works like before
//   - "!term" excludes files matching term (also "!.ext" excludes an extension)
//   - ".ext" (when other terms are present) filters by extension, e.g. "ams .java"
//   - when few or no strict matches are found, a fuzzy pass matches terms as
//     scored subsequences, so "actmgr" finds ActivityManagerService.java
//
// Ranking: exact name > name prefix > shortName acronym > name substring >
// path match > fuzzy-only match, with recency boost and fuzzy score as
// tie-breakers. An acronym match (e.g. "ams" -> ActivityManagerService) is a
// strong intent signal and outranks incidental name substrings ("cams.h").

import { IndexedFile } from './indexedFile';

export const enum MatchKind {
    None = 0,
    Fuzzy = 1,
    Path = 2,
    Substring = 3,
    Acronym = 4,
    Prefix = 5,
    Exact = 6,
}

export interface CompiledPattern {
    /** input with a leading "./" stripped */
    readonly text: string;
    readonly lower: string;
    /** lowercased positive terms */
    readonly terms: string[];
    /** lowercased terms that must NOT match (strict matching semantics) */
    readonly negatedTerms: string[];
    /** extensions (no dot) every match must have, e.g. ["java"] */
    readonly extFilters: string[];
    /** extensions (no dot) no match may have */
    readonly negatedExtFilters: string[];
    /** true when at least one positive term contains '/' and thus matches the path */
    readonly hasSlashTerm: boolean;
    /** true when every positive term is basename-only, i.e. servable by the trigram index */
    readonly allPlainTerms: boolean;
}

const EXT_TERM = /^\.[a-z0-9]+$/;

export function compilePattern(input: string): CompiledPattern {
    const text = input.startsWith("./") ? input.substring(2) : input;
    const lower = text.toLowerCase();
    const rawTerms = lower.split(/\s+/).filter(t => t.length > 0);
    const terms: string[] = [];
    const negatedTerms: string[] = [];
    const extFilters: string[] = [];
    const negatedExtFilters: string[] = [];
    for (const raw of rawTerms) {
        if (raw.startsWith('!') && raw.length > 1) {
            const t = raw.substring(1);
            if (EXT_TERM.test(t)) {
                negatedExtFilters.push(t.substring(1));
            } else {
                negatedTerms.push(t);
            }
        } else if (EXT_TERM.test(raw)) {
            extFilters.push(raw.substring(1));
        } else {
            terms.push(raw);
        }
    }
    if (terms.length === 0 && extFilters.length > 0) {
        // a lone ".gitignore" is a name search, not an extension filter
        for (const ext of extFilters) {
            terms.push("." + ext);
        }
        extFilters.length = 0;
    }
    const hasSlashTerm = terms.some(t => t.indexOf('/') >= 0);
    return {
        text,
        lower,
        terms,
        negatedTerms,
        extFilters,
        negatedExtFilters,
        hasSlashTerm,
        allPlainTerms: terms.length > 0 && !hasSlashTerm,
    };
}

/** Whether some path segment starts with term; p must be lowercased. */
export function pathHasSegmentPrefix(p: string, term: string): boolean {
    let start = 0;
    for (let i = 0; i <= p.length; i++) {
        if (i === p.length || p[i] === '/' || p[i] === '\\') {
            if (i - start >= term.length && p.startsWith(term, start)) {
                return true;
            }
            start = i + 1;
        }
    }
    return false;
}

function basenameHasExt(basenameLower: string, ext: string): boolean {
    return basenameLower.endsWith("." + ext);
}

function matchTerm(term: string, file: IndexedFile, getPathLower: () => string): MatchKind {
    if (term.indexOf('/') >= 0) {
        return getPathLower().indexOf(term) >= 0 ? MatchKind.Path : MatchKind.None;
    }
    const bn = file.basenameLower;
    const dot = bn.lastIndexOf('.');
    const stem = dot > 0 ? bn.substring(0, dot) : bn;
    if (bn === term || stem === term) return MatchKind.Exact;
    if (bn.startsWith(term) || stem.startsWith(term)) return MatchKind.Prefix;
    if (bn.indexOf(term) >= 0) return MatchKind.Substring;
    if (file.shortName.startsWith(term)) return MatchKind.Acronym;
    if (pathHasSegmentPrefix(getPathLower(), term)) return MatchKind.Path;
    return MatchKind.None;
}

function makePathLowerThunk(file: IndexedFile): () => string {
    let cached: string | null = null;
    return () => {
        if (cached === null) {
            cached = file.path.toLowerCase();
        }
        return cached;
    };
}

function excludedByFilters(pattern: CompiledPattern, file: IndexedFile,
    getPathLower: () => string): boolean {
    const bn = file.basenameLower;
    for (const ext of pattern.extFilters) {
        if (!basenameHasExt(bn, ext)) return true;
    }
    for (const ext of pattern.negatedExtFilters) {
        if (basenameHasExt(bn, ext)) return true;
    }
    for (const term of pattern.negatedTerms) {
        if (matchTerm(term, file, getPathLower) !== MatchKind.None) return true;
    }
    return false;
}

/**
 * Strict match of a whole pattern against a file: the weakest MatchKind across
 * all positive terms (all must match), or MatchKind.None when the file does
 * not match or is excluded by '!term' / ext filters.
 */
export function matchFile(pattern: CompiledPattern, file: IndexedFile): MatchKind {
    const getPathLower = makePathLowerThunk(file);
    if (excludedByFilters(pattern, file, getPathLower)) {
        return MatchKind.None;
    }
    if (pattern.terms.length === 0) {
        // e.g. a pure negation query like "!test": everything else matches
        return MatchKind.Path;
    }
    let worst = MatchKind.Exact;
    for (const term of pattern.terms) {
        const kind = matchTerm(term, file, getPathLower);
        if (kind === MatchKind.None) return MatchKind.None;
        if (kind < worst) worst = kind;
    }
    return worst;
}

/**
 * Greedy leftmost-subsequence fuzzy match of term inside word (both lowercased).
 * Returns a quality score (higher is better) or 0 when term is not a
 * subsequence. Rewards consecutive runs and matches at word boundaries,
 * penalizes gaps - a light version of fzf's scoring.
 */
export function fuzzyScoreTerm(term: string, word: string): number {
    let score = 0;
    let ti = 0;
    let prevMatch = -2;
    let consecutive = 0;
    for (let wi = 0; wi < word.length && ti < term.length; wi++) {
        if (word.charCodeAt(wi) !== term.charCodeAt(ti)) continue;
        let s = 8;
        if (wi === prevMatch + 1) {
            consecutive++;
            s += 8 + 2 * Math.min(consecutive, 4);
        } else {
            consecutive = 0;
            if (prevMatch >= 0) {
                s -= Math.min(wi - prevMatch - 1, 6);
            }
        }
        if (wi === 0) {
            s += 12;
        } else {
            const prev = word[wi - 1];
            if (prev === '_' || prev === '-' || prev === '.' || prev === '/') {
                s += 10;
            }
        }
        score += s;
        prevMatch = wi;
        ti++;
    }
    return ti === term.length ? score : 0;
}

/** Fuzzy match of a pattern against a file: sum of per-term scores, 0 when any term misses. */
export function fuzzyScoreFile(pattern: CompiledPattern, file: IndexedFile): number {
    if (pattern.terms.length === 0) return 0;
    const getPathLower = makePathLowerThunk(file);
    if (excludedByFilters(pattern, file, getPathLower)) return 0;
    let total = 0;
    for (const term of pattern.terms) {
        const word = term.indexOf('/') >= 0 ? getPathLower() : file.basenameLower;
        const s = fuzzyScoreTerm(term, word);
        if (s === 0) return 0;
        total += s;
    }
    return total;
}

export interface Match {
    fileIdx: number;
    kind: MatchKind;
    /** fuzzy quality score (only for MatchKind.Fuzzy) */
    score?: number;
}

export interface FindMatchesResult {
    matches: Match[];
    /** true when the scan stopped early and more matches may exist */
    truncated: boolean;
}

export interface FindMatchesOptions {
    /** candidate file indices to scan (from the trigram index); scan all when null */
    candidates?: Uint32Array | null;
    /** max matches returned (default 300) */
    limit?: number;
    /** max strict matches collected before stopping the scan (default 2000) */
    scanLimit?: number;
    /** run the fuzzy pass when fewer strict matches than this were found (default 10, <=0 disables) */
    fuzzyThreshold?: number;
    /** checked at every yield point; the search aborts (returns null) when true */
    isCancelled?: () => boolean;
    /** called once with the first matches found, for early display */
    onFirstMatches?: (matches: Match[]) => void | Promise<void>;
    /** files examined between two event loop yields (default 2000) */
    yieldEvery?: number;
    /** higher means more recently opened; used as a tie-breaker within a rank */
    rankBoost?: (absPath: string) => number;
}

function yieldToEventLoop() {
    return new Promise<void>(resolve => setImmediate(resolve));
}

function compareMatches(files: readonly IndexedFile[], rankBoost?: (absPath: string) => number) {
    return (a: Match, b: Match): number => {
        if (a.kind !== b.kind) return b.kind - a.kind;
        const fa = files[a.fileIdx], fb = files[b.fileIdx];
        if (rankBoost) {
            const ba = rankBoost(fa.path), bb = rankBoost(fb.path);
            if (ba !== bb) return bb - ba;
        }
        const sa = a.score || 0, sb = b.score || 0;
        if (sa !== sb) return sb - sa;
        const la = fa.basenameLower.length, lb = fb.basenameLower.length;
        if (la !== lb) return la - lb;
        return fa.path < fb.path ? -1 : 1;
    };
}

// Scans the file list (or the given candidate set) for pattern matches.
// Returns null when the search was cancelled via options.isCancelled.
export async function findMatches(files: readonly IndexedFile[], pattern: CompiledPattern,
    options: FindMatchesOptions = {}): Promise<FindMatchesResult | null> {
    const limit = options.limit !== undefined ? options.limit : 300;
    const scanLimit = options.scanLimit !== undefined ? options.scanLimit : 2000;
    const fuzzyThreshold = options.fuzzyThreshold !== undefined ? options.fuzzyThreshold : 10;
    const yieldEvery = options.yieldEvery !== undefined ? options.yieldEvery : 2000;
    const candidates = options.candidates ?? null;
    const useCandidates = candidates !== null;
    const total = useCandidates ? candidates.length : files.length;
    const strictMatches: Match[] = [];
    const strictSet = new Set<number>();
    let truncated = false;
    let firstMatchesSent = false;

    for (let i = 0; i < total; i++) {
        // Yield to the event loop periodically so the UI stays responsive, and
        // bail out if a newer search has started in the meantime.
        if (i > 0 && (i % yieldEvery) === 0) {
            await yieldToEventLoop();
            if (options.isCancelled && options.isCancelled()) return null;
        }
        if (strictMatches.length >= scanLimit) {
            truncated = true;
            break;
        }
        const fileIdx = useCandidates ? candidates[i] : i;
        const kind = matchFile(pattern, files[fileIdx]);
        if (kind === MatchKind.None) continue;
        strictMatches.push({ fileIdx, kind });
        strictSet.add(fileIdx);
        if (!firstMatchesSent && strictMatches.length >= 10 && options.onFirstMatches) {
            firstMatchesSent = true;
            await options.onFirstMatches(strictMatches.slice());
        }
    }
    if (options.isCancelled && options.isCancelled()) return null;

    // Fuzzy pass: when strict matching found little, look for subsequence
    // matches over the whole list (the trigram index cannot prune these).
    let fuzzyMatches: Match[] = [];
    if (fuzzyThreshold > 0 && strictMatches.length < fuzzyThreshold && pattern.terms.length > 0) {
        const pass = await fuzzyPass(files, pattern, strictSet, limit, yieldEvery,
            options.isCancelled);
        if (pass === null) return null;
        fuzzyMatches = pass.matches;
        truncated = truncated || pass.truncated;
    }

    const all = strictMatches.concat(fuzzyMatches);
    all.sort(compareMatches(files, options.rankBoost));
    if (all.length > limit) {
        truncated = true;
    }
    return { matches: all.slice(0, limit), truncated };
}

async function fuzzyPass(files: readonly IndexedFile[], pattern: CompiledPattern,
    strictSet: Set<number>, limit: number, yieldEvery: number,
    isCancelled?: () => boolean): Promise<FindMatchesResult | null> {
    const kept: Match[] = [];
    let truncated = false;
    for (let i = 0; i < files.length; i++) {
        if (i > 0 && (i % yieldEvery) === 0) {
            await yieldToEventLoop();
            if (isCancelled && isCancelled()) return null;
        }
        if (strictSet.has(i)) continue;
        const score = fuzzyScoreFile(pattern, files[i]);
        if (score === 0) continue;
        kept.push({ fileIdx: i, kind: MatchKind.Fuzzy, score });
        if (kept.length > 4 * limit) {
            // bound memory: drop the weakest half
            kept.sort((a, b) => (b.score || 0) - (a.score || 0));
            kept.length = 2 * limit;
            truncated = true;
        }
    }
    kept.sort((a, b) => (b.score || 0) - (a.score || 0));
    if (kept.length > limit) {
        kept.length = limit;
        truncated = true;
    }
    return { matches: kept, truncated };
}
