// Trigram inverted index over basenameLower of every IndexedFile, a companion
// shortName bucket index and a directory-segment index. Pure logic, no vscode
// dependency. Also supports binary (de)serialization so the index survives
// extension host restarts.
//
// Trigram index: maps each 3-char substring of the basename to the sorted list
// of file indices whose basename contains it. Pattern lookup intersects the
// posting lists for the pattern's trigrams to obtain a small candidate set,
// avoiding a full scan.
//
// Stored as Uint32Array (4B/entry) instead of number[] (~50B/entry in V8) to
// keep memory bounded on large workspaces (~15-20MB for 310k files).
//
// The trigram index is over basenameLower, so it would miss CamelCase shortName
// matches like "ams" -> ActivityManagerService. For each non-empty shortName we
// bucket (shortName, fileIdx) by its first character so a
// shortName.startsWith(pattern) lookup scans only one bucket.
//
// The segment index maps every (lowercased) directory name to the files living
// under it, so plain terms can also match directories ("src" -> anything under
// a src/ directory) and still be pruned without a full scan.

import { IndexedFile } from './indexedFile';

export interface TrigramIndex {
    postings: Map<string, Uint32Array>;
    shortNameByFirstChar: Map<string, Array<[string, number]>>;
    segmentPostings: Map<string, Uint32Array>;
    fileCount: number;
}

const TRIGRAM_LEN = 3;

export function buildTrigramIndex(fileList: IndexedFile[]): TrigramIndex {
    const builder: Map<string, number[]> = new Map();
    const seenInThisFile = new Set<string>();
    const shortNameByFirstChar: Map<string, Array<[string, number]>> = new Map();
    const segmentBuilder: Map<string, number[]> = new Map();
    for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        const bn = f.basenameLower;
        if (bn.length >= TRIGRAM_LEN) {
            seenInThisFile.clear();
            const last = bn.length - TRIGRAM_LEN;
            for (let j = 0; j <= last; j++) {
                const gram = bn.substr(j, TRIGRAM_LEN);
                if (seenInThisFile.has(gram)) continue;
                seenInThisFile.add(gram);
                pushIndex(builder, gram, i);
            }
        }
        if (f.shortName.length > 0) {
            const c = f.shortName.charAt(0);
            let bucket = shortNameByFirstChar.get(c);
            if (!bucket) {
                bucket = [];
                shortNameByFirstChar.set(c, bucket);
            }
            bucket.push([f.shortName, i]);
        }
        seenInThisFile.clear();
        forEachDirSegment(f.path, segment => {
            const key = segment.toLowerCase();
            if (seenInThisFile.has(key)) return; // a path may repeat a segment
            seenInThisFile.add(key);
            pushIndex(segmentBuilder, key, i);
        });
    }
    return {
        postings: finalize(builder),
        shortNameByFirstChar,
        segmentPostings: finalize(segmentBuilder),
        fileCount: fileList.length,
    };
}

function pushIndex(builder: Map<string, number[]>, key: string, fileIdx: number) {
    let list = builder.get(key);
    if (!list) {
        list = [];
        builder.set(key, list);
    }
    // fileIdx is monotonically increasing, so list stays sorted.
    list.push(fileIdx);
}

function finalize(builder: Map<string, number[]>): Map<string, Uint32Array> {
    const result: Map<string, Uint32Array> = new Map();
    builder.forEach((list, key) => {
        result.set(key, Uint32Array.from(list));
    });
    return result;
}

/** Invokes cb for every segment of the directory part of p (not the basename). */
export function forEachDirSegment(p: string, cb: (segment: string) => void) {
    const lastSep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    let start = 0;
    for (let i = 0; i < lastSep; i++) {
        if (p[i] === '/' || p[i] === '\\') {
            if (i > start) {
                cb(p.substring(start, i));
            }
            start = i + 1;
        }
    }
    if (lastSep > start) {
        cb(p.substring(start, lastSep));
    }
}

// Intersect two sorted Uint32Array posting lists into a new Uint32Array.
function intersectSorted(a: Uint32Array, b: Uint32Array): Uint32Array {
    const out = new Uint32Array(Math.min(a.length, b.length));
    let ai = 0, bi = 0, oi = 0;
    while (ai < a.length && bi < b.length) {
        const av = a[ai], bv = b[bi];
        if (av === bv) {
            out[oi++] = av;
            ai++; bi++;
        } else if (av < bv) {
            ai++;
        } else {
            bi++;
        }
    }
    return out.slice(0, oi);
}

// Union two sorted Uint32Array posting lists into a new Uint32Array, deduping.
function unionSorted(a: Uint32Array, b: Uint32Array): Uint32Array {
    const out = new Uint32Array(a.length + b.length);
    let ai = 0, bi = 0, oi = 0;
    while (ai < a.length && bi < b.length) {
        const av = a[ai], bv = b[bi];
        if (av === bv) {
            out[oi++] = av;
            ai++; bi++;
        } else if (av < bv) {
            out[oi++] = av;
            ai++;
        } else {
            out[oi++] = bv;
            bi++;
        }
    }
    while (ai < a.length) out[oi++] = a[ai++];
    while (bi < b.length) out[oi++] = b[bi++];
    return out.slice(0, oi);
}

function unionAll(lists: Uint32Array[]): Uint32Array {
    if (lists.length === 0) return new Uint32Array(0);
    // Union smallest first to keep the running set small.
    lists.sort((x, y) => x.length - y.length);
    let acc = lists[0];
    for (let k = 1; k < lists.length; k++) {
        acc = unionSorted(acc, lists[k]);
    }
    return acc;
}

// Walks the shortName bucket for the pattern's first character and returns the
// sorted file indices whose shortName starts with the pattern.
function lookupShortNameCandidates(index: TrigramIndex, patternLower: string): Uint32Array {
    const bucket = index.shortNameByFirstChar.get(patternLower.charAt(0));
    if (!bucket) return new Uint32Array(0);
    const hits: number[] = [];
    for (let i = 0; i < bucket.length; i++) {
        if (bucket[i][0].startsWith(patternLower)) hits.push(bucket[i][1]);
    }
    if (hits.length === 0) return new Uint32Array(0);
    // Bucket order matches insertion order (i is monotonically increasing per
    // file in buildTrigramIndex), so hits are already sorted.
    return Uint32Array.from(hits);
}

// Returns the files living under any directory whose name starts with the term.
function lookupSegmentCandidates(index: TrigramIndex, termLower: string): Uint32Array {
    const lists: Uint32Array[] = [];
    index.segmentPostings.forEach((list, segment) => {
        if (segment.startsWith(termLower)) {
            lists.push(list);
        }
    });
    return unionAll(lists);
}

// Candidate file indices for a single term (which must not contain '/').
// Returns null when the caller should fall back to a full scan (no index built
// yet, or term shorter than a single trigram). Returns an empty array when the
// index proves there cannot be any matches.
function lookupTermCandidates(index: TrigramIndex, termLower: string): Uint32Array | null {
    if (termLower.length < TRIGRAM_LEN) return null;
    const last = termLower.length - TRIGRAM_LEN;
    const lists: Uint32Array[] = [];
    for (let j = 0; j <= last; j++) {
        const gram = termLower.substr(j, TRIGRAM_LEN);
        const list = index.postings.get(gram);
        if (!list || list.length === 0) {
            // No basename contains this trigram, but a shortName or segment
            // match might still exist (e.g. "ams" -> ActivityManagerService).
            lists.length = 0;
            break;
        }
        lists.push(list);
    }
    const basenameCandidates = lists.length === 0 ? new Uint32Array(0)
        : (lists.length === 1 ? lists[0] : intersectAll(lists));
    const shortNameCandidates = lookupShortNameCandidates(index, termLower);
    const segmentCandidates = lookupSegmentCandidates(index, termLower);
    return unionAll([basenameCandidates, shortNameCandidates, segmentCandidates]
        .filter(list => list.length > 0));
}

function intersectAll(lists: Uint32Array[]): Uint32Array {
    // Intersect shortest first to keep the running set small.
    lists.sort((x, y) => x.length - y.length);
    let acc = lists[0];
    for (let k = 1; k < lists.length && acc.length > 0; k++) {
        acc = intersectSorted(acc, lists[k]);
    }
    return acc;
}

// Candidate file indices for a whole pattern: every positive term must match,
// so the per-term candidate sets are intersected. Returns null when the caller
// should fall back to a full scan (index missing, a term shorter than a
// trigram, or a term containing '/' which the basename index cannot serve).
// Returns an empty array when the index proves there cannot be any matches.
export function lookupCandidates(index: TrigramIndex | undefined, terms: string[]): Uint32Array | null {
    if (!index) return null;
    if (terms.length === 0) return null;
    let acc: Uint32Array | null = null;
    for (const term of terms) {
        if (term.indexOf('/') >= 0) return null;
        const cands = lookupTermCandidates(index, term);
        if (cands === null) return null;
        if (acc === null) {
            acc = cands;
        } else {
            acc = intersectSorted(acc, cands);
        }
        if (acc.length === 0) return acc;
    }
    return acc;
}

// ---------------------------------------------------------------------------
// Binary (de)serialization, used to cache the index across restarts.
// ---------------------------------------------------------------------------

const MAGIC = Buffer.from("QFIDX01\n", 'ascii');
const FORMAT_VERSION = 1;

/** FNV-1a hash over the file list; used to detect stale caches. */
export function hashPaths(paths: Iterable<string>): number {
    let h = 0x811c9dc5;
    for (const p of paths) {
        for (let i = 0; i < p.length; i++) {
            h ^= p.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        h ^= 0x1f; // unit separator between paths
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

class ByteWriter {
    private buf: Buffer;
    private pos = 0;

    constructor(initialCapacity: number) {
        this.buf = Buffer.allocUnsafe(initialCapacity);
    }

    private ensure(n: number) {
        if (this.pos + n <= this.buf.length) return;
        let cap = this.buf.length * 2;
        while (cap < this.pos + n) cap *= 2;
        const next = Buffer.allocUnsafe(cap);
        this.buf.copy(next, 0, 0, this.pos);
        this.buf = next;
    }

    u32(v: number) {
        this.ensure(4);
        this.buf.writeUInt32LE(v >>> 0, this.pos);
        this.pos += 4;
    }

    u16(v: number) {
        this.ensure(2);
        this.buf.writeUInt16LE(v & 0xffff, this.pos);
        this.pos += 2;
    }

    str(s: string) {
        const bytes = Buffer.from(s, 'utf8');
        this.u16(bytes.length);
        this.bytes(bytes);
    }

    bytes(src: Buffer) {
        this.ensure(src.length);
        src.copy(this.buf, this.pos);
        this.pos += src.length;
    }

    toBuffer(): Buffer {
        return this.buf.slice(0, this.pos);
    }
}

export function serializeTrigramIndex(index: TrigramIndex, listHash: number): Buffer {
    let postingCount = 0;
    index.postings.forEach(list => postingCount += list.length);
    let segmentCount = 0;
    index.segmentPostings.forEach(list => segmentCount += list.length);
    let shortNameCount = 0;
    index.shortNameByFirstChar.forEach(bucket => shortNameCount += bucket.length);
    // rough size estimate: 4 bytes per posting + key/entry overhead
    const w = new ByteWriter(4 * (postingCount + segmentCount) + 32 * shortNameCount + (1 << 16));

    w.bytes(MAGIC);
    w.u32(FORMAT_VERSION);
    w.u32(index.fileCount);
    w.u32(listHash);

    w.u32(index.postings.size);
    index.postings.forEach((list, gram) => {
        w.str(gram);
        w.u32(list.length);
        for (let i = 0; i < list.length; i++) w.u32(list[i]);
    });

    w.u32(index.shortNameByFirstChar.size);
    index.shortNameByFirstChar.forEach((bucket, key) => {
        w.str(key);
        w.u32(bucket.length);
        for (const [shortName, fileIdx] of bucket) {
            w.str(shortName);
            w.u32(fileIdx);
        }
    });

    w.u32(index.segmentPostings.size);
    index.segmentPostings.forEach((list, segment) => {
        w.str(segment);
        w.u32(list.length);
        for (let i = 0; i < list.length; i++) w.u32(list[i]);
    });

    return w.toBuffer();
}

// Parses a serialized index. Returns null when the buffer does not match the
// expected format version or the given file-list hash (stale cache).
export function deserializeTrigramIndex(buf: Buffer, expectedListHash: number): TrigramIndex | null {
    let pos = 0;
    const u32 = (): number => {
        const v = buf.readUInt32LE(pos);
        pos += 4;
        return v;
    };
    const u16 = (): number => {
        const v = buf.readUInt16LE(pos);
        pos += 2;
        return v;
    };
    const str = (): string => {
        const len = u16();
        const s = buf.toString('utf8', pos, pos + len);
        pos += len;
        return s;
    };

    try {
        if (buf.length < MAGIC.length || !buf.slice(0, MAGIC.length).equals(MAGIC)) return null;
        pos = MAGIC.length;
        if (u32() !== FORMAT_VERSION) return null;
        const fileCount = u32();
        if (u32() !== expectedListHash) return null;

        const postings: Map<string, Uint32Array> = new Map();
        const numGrams = u32();
        for (let i = 0; i < numGrams; i++) {
            const gram = str();
            const count = u32();
            const list = new Uint32Array(count);
            for (let j = 0; j < count; j++) list[j] = u32();
            postings.set(gram, list);
        }

        const shortNameByFirstChar: Map<string, Array<[string, number]>> = new Map();
        const numBuckets = u32();
        for (let i = 0; i < numBuckets; i++) {
            const key = str();
            const count = u32();
            const bucket: Array<[string, number]> = [];
            for (let j = 0; j < count; j++) {
                bucket.push([str(), u32()]);
            }
            shortNameByFirstChar.set(key, bucket);
        }

        const segmentPostings: Map<string, Uint32Array> = new Map();
        const numSegments = u32();
        for (let i = 0; i < numSegments; i++) {
            const segment = str();
            const count = u32();
            const list = new Uint32Array(count);
            for (let j = 0; j < count; j++) list[j] = u32();
            segmentPostings.set(segment, list);
        }

        return { postings, shortNameByFirstChar, segmentPostings, fileCount };
    } catch (e) {
        return null; // truncated / corrupt buffer
    }
}
