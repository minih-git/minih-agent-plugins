import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Vector index persistence (ADR 0001 §6).
 *
 * Layout under the index directory:
 *   vectors.f32  concatenated Float32 vectors, row per chunk
 *   chunks.jsonl one JSON row per chunk: path, headingPath, start, end, sha
 *                (never the text itself)
 *   meta.json    { formatVersion, model, dims, count } — written last
 *   .lock        O_EXCL writer lock; a lock older than 10 minutes is stale
 *
 * A loader that finds `vectors.f32` of the wrong size discards the index and
 * rebuilds. Concurrent writers (MCP server, Desktop view, CLI): only the lock
 * holder writes; everyone else reads the index as it is.
 */

const FORMAT_VERSION = 1;
const LOCK_STALE_MS = 10 * 60 * 1000;

export class VectorIndex {
  constructor(directory) {
    this.directory = directory;
    this.chunks = [];
    this.vectors = null;
    this.meta = null;
  }

  async load({ identity, dims }) {
    let meta;
    let rows;
    let buffer;
    try {
      meta = JSON.parse(await readFile(path.join(this.directory, "meta.json"), "utf8"));
      rows = (await readFile(path.join(this.directory, "chunks.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      buffer = await readFile(path.join(this.directory, "vectors.f32"));
    } catch {
      return false;
    }
    const expectedBytes = rows.length * dims * 4;
    if (
      meta.formatVersion !== FORMAT_VERSION ||
      meta.identity !== identity ||
      meta.dims !== dims ||
      buffer.length !== expectedBytes
    ) {
      return false;
    }
    this.meta = meta;
    this.chunks = rows;
    this.vectors = new Float32Array(buffer.buffer, buffer.byteOffset, rows.length * dims);
    return true;
  }

  /** Best cosine match for a normalized query vector; brute force. */
  search(queryVector, { limit = 50, onlyShas = null } = {}) {
    if (!this.vectors || this.chunks.length === 0) return [];
    const dims = this.meta.dims;
    const scored = [];
    for (let row = 0; row < this.chunks.length; row += 1) {
      if (onlyShas && !onlyShas.has(this.chunks[row].sha)) continue;
      let dot = 0;
      const offset = row * dims;
      for (let i = 0; i < dims; i += 1) dot += this.vectors[offset + i] * queryVector[i];
      scored.push({ row, score: dot });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ row, score }) => ({ chunk: this.chunks[row], score }));
  }

  /** Replace the stored index atomically; meta.json lands last. */
  async save({ rows, vectors, identity, dims }) {
    const lock = await this.acquireLock();
    if (!lock) return false;
    try {
      // Per-process temp names: two processes that briefly hold overlapping
      // write windows must never rename each other's files out from under them.
      const temp = (name) => path.join(this.directory, `.${name}.${process.pid}.tmp`);
      await writeFile(temp("chunks.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
      await writeFile(temp("vectors.f32"), Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
      await rename(temp("chunks.jsonl"), path.join(this.directory, "chunks.jsonl"));
      await rename(temp("vectors.f32"), path.join(this.directory, "vectors.f32"));
      await writeFile(path.join(this.directory, "meta.json"), `${JSON.stringify({ formatVersion: FORMAT_VERSION, identity, dims, count: rows.length }, null, 2)}\n`);
      this.chunks = rows;
      this.vectors = vectors;
      this.meta = { formatVersion: FORMAT_VERSION, identity, dims, count: rows.length };
      return true;
    } finally {
      await lock.release();
    }
  }

  /** `O_EXCL` lock; removes a stale lock older than 10 minutes first. */
  async acquireLock() {
    const lockPath = path.join(this.directory, ".lock");
    let handle = null;
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        const { unlink } = await import("node:fs/promises");
        await unlink(lockPath).catch(() => {});
        try {
          handle = await open(lockPath, "wx");
        } catch {
          return null;
        }
      } else {
        return null;
      }
    }
    await handle.write(`${process.pid}\n`, 0);
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        await handle.close().catch(() => {});
        const { unlink } = await import("node:fs/promises");
        await unlink(lockPath).catch(() => {});
      },
    };
  }
}
