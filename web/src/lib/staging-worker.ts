/**
 * Owns the staged copy of every in-progress download, inside the Origin Private
 * File System.
 *
 * Staged files are split into fixed-size **segments**, for two reasons:
 *
 *  1. A single OPFS file cannot grow past 2000 MiB in Chrome — the write simply
 *     returns error code -8, with quota to spare — so one file per transfer
 *     would cap every download at 2 GB.
 *  2. Segments can be deleted individually, which lets the save copy forward and
 *     drop each segment as it goes. Truncating a single file could not do that:
 *     truncation only removes from the end, and browsers charge storage by file
 *     length rather than allocated blocks.
 *
 * Everything here runs in a worker because `createSyncAccessHandle()` — the only
 * API giving random-access reads and writes — is worker-only in Safari and
 * blocks whichever thread it runs on.
 */

import { Sha256 } from "./sha256";

/**
 * Well under the 2000 MiB ceiling, and a multiple of every chunk size, so no
 * chunk ever straddles two segments. Also the granularity at which a save
 * reclaims space, so it bounds the extra disk a save needs.
 */
export const SEGMENT_BYTES = 256 * 1024 * 1024;

/** Bytes read per pass when hashing. */
const STREAM_BLOCK = 8 * 1024 * 1024;

type Request =
  | { id: number; op: "write"; file: string; offset: number; data: ArrayBuffer }
  | { id: number; op: "read"; file: string; offset: number; length: number }
  | { id: number; op: "hash"; file: string; length: number }
  | { id: number; op: "size"; file: string }
  | { id: number; op: "dropSegment"; file: string; index: number }
  | { id: number; op: "close"; file: string }
  | { id: number; op: "remove"; file: string }
  | { id: number; op: "list" };

const context = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<Request>) => void): void;
};

/** One open sync handle per segment; OPFS allows only one at a time. */
const open = new Map<string, FileSystemSyncAccessHandle>();

const segmentName = (file: string, index: number) => `${file}.${index}`;

async function directory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("staged", { create: true });
}

async function segment(file: string, index: number): Promise<FileSystemSyncAccessHandle> {
  const name = segmentName(file, index);
  const existing = open.get(name);
  if (existing) return existing;

  const dir = await directory();
  const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  open.set(name, handle);
  return handle;
}

function closeSegment(name: string): void {
  open.get(name)?.close();
  open.delete(name);
}

function closeAll(file: string): void {
  for (const name of [...open.keys()]) {
    if (name.startsWith(`${file}.`)) closeSegment(name);
  }
}

/**
 * Walks a byte range across segment boundaries, calling `visit` with the handle
 * and the slice of the range that falls inside each one.
 */
async function acrossSegments(
  file: string,
  offset: number,
  length: number,
  visit: (handle: FileSystemSyncAccessHandle, at: number, from: number, count: number) => void,
): Promise<void> {
  let done = 0;
  while (done < length) {
    const absolute = offset + done;
    const index = Math.floor(absolute / SEGMENT_BYTES);
    const within = absolute - index * SEGMENT_BYTES;
    const count = Math.min(length - done, SEGMENT_BYTES - within);
    visit(await segment(file, index), within, done, count);
    done += count;
  }
}

async function totalSize(file: string): Promise<number> {
  const dir = await directory();
  let total = 0;
  for await (const [name, entry] of (
    dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
  ).entries()) {
    if (entry.kind !== "file" || !name.startsWith(`${file}.`)) continue;
    const held = open.get(name);
    total += held ? held.getSize() : (await (entry as FileSystemFileHandle).getFile()).size;
  }
  return total;
}

async function run(request: Request): Promise<unknown> {
  switch (request.op) {
    case "write": {
      const data = new Uint8Array(request.data);
      await acrossSegments(request.file, request.offset, data.length, (handle, at, from, count) => {
        const slice = data.subarray(from, from + count);
        // A short write is how running out of quota — or the per-file ceiling —
        // shows up. Ignoring the count would turn it into silent corruption that
        // only the final checksum catches.
        const written = handle.write(slice, { at });
        if (written !== count) {
          throw new Error(
            `only ${written} of ${count} bytes could be written at ${request.offset + from}` +
              ` (segment offset ${at}) — storage is full or the file hit a browser limit`,
          );
        }
        // Flushed per write so the bitmap the main thread is about to record can
        // never claim bytes that are not durably on disk.
        handle.flush();
      });
      return true;
    }

    case "read": {
      const buffer = new Uint8Array(new ArrayBuffer(request.length));
      let read = 0;
      await acrossSegments(request.file, request.offset, request.length, (handle, at, from, count) => {
        read += handle.read(buffer.subarray(from, from + count), { at });
      });
      return { data: buffer.buffer, read };
    }

    case "hash": {
      // Streamed in blocks, so a 10 GB file costs 8 MB of memory to verify.
      const hash = new Sha256();
      const buffer = new Uint8Array(new ArrayBuffer(STREAM_BLOCK));
      for (let offset = 0; offset < request.length; offset += STREAM_BLOCK) {
        const wanted = Math.min(STREAM_BLOCK, request.length - offset);
        let read = 0;
        await acrossSegments(request.file, offset, wanted, (handle, at, from, count) => {
          read += handle.read(buffer.subarray(from, from + count), { at });
        });
        if (read !== wanted) throw new Error(`staged file ended early at ${offset + read}`);
        hash.update(buffer.subarray(0, wanted));
        context.postMessage({ id: request.id, progress: (offset + wanted) / request.length });
      }
      return hash.hex();
    }

    case "size":
      return totalSize(request.file);

    /** Frees one segment once a save has copied it out. */
    case "dropSegment": {
      const name = segmentName(request.file, request.index);
      closeSegment(name);
      const dir = await directory();
      await dir.removeEntry(name).catch(() => {});
      return true;
    }

    case "close":
      closeAll(request.file);
      return true;

    case "remove": {
      closeAll(request.file);
      const dir = await directory();
      const names: string[] = [];
      for await (const [name, entry] of (
        dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
      ).entries()) {
        if (entry.kind === "file" && name.startsWith(`${request.file}.`)) names.push(name);
      }
      for (const name of names) await dir.removeEntry(name).catch(() => {});
      return true;
    }

    case "list": {
      // Segments are rolled back up into one entry per transfer.
      const dir = await directory();
      const totals = new Map<string, number>();
      for await (const [name, entry] of (
        dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
      ).entries()) {
        if (entry.kind !== "file") continue;
        const base = name.replace(/\.\d+$/, "");
        const held = open.get(name);
        const size = held ? held.getSize() : (await (entry as FileSystemFileHandle).getFile()).size;
        totals.set(base, (totals.get(base) ?? 0) + size);
      }
      return [...totals].map(([file, size]) => ({ file, size }));
    }
  }
}

context.addEventListener("message", (event) => {
  const request = event.data;
  void run(request).then(
    (value) => {
      const transfer = request.op === "read" ? [(value as { data: ArrayBuffer }).data] : undefined;
      context.postMessage({ id: request.id, ok: true, value }, transfer);
    },
    (error: unknown) => {
      context.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
});
