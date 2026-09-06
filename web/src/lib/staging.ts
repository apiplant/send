/**
 * Main-thread client for the staged-file worker, plus the save-out path.
 *
 * Partial downloads are staged in the Origin Private File System rather than as
 * rows in IndexedDB: OPFS gives random-access writes at roughly 300 MB/s, costs
 * nothing in memory, and — unlike the File System Access pickers — exists in
 * every current browser including iOS. IndexedDB is left holding only each
 * transfer's metadata and its chunk bitmap.
 *
 * The staged bytes are split into segments; see staging-worker.ts for why.
 */

import { clearRecords, deleteRecord, listTransfers, type TransferRecord } from "./idb";

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?(fraction: number): void;
};

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./staging-worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event) => {
      const message = event.data as {
        id: number;
        ok?: boolean;
        value?: unknown;
        error?: string;
        progress?: number;
      };
      const waiter = pending.get(message.id);
      if (!waiter) return;

      if (message.progress !== undefined) {
        waiter.onProgress?.(message.progress);
        return;
      }
      pending.delete(message.id);
      if (message.ok) waiter.resolve(message.value);
      else waiter.reject(new Error(message.error ?? "staged file operation failed"));
    });
  }
  return worker;
}

function call<T>(
  request: Record<string, unknown>,
  transfer?: Transferable[],
  onProgress?: (fraction: number) => void,
): Promise<T> {
  const id = nextId++;
  const active = ensureWorker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress });
    active.postMessage({ ...request, id }, transfer ?? []);
  });
}

/** OPFS is unavailable in very old browsers and in some private modes. */
export function stagingSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}

const fileName = (id: string) => `${id}.part`;

/** Segment size, mirrored from the worker so the save can drop them in step. */
export const SEGMENT_BYTES = 256 * 1024 * 1024;

export const staging = {
  /** Writes one chunk at its absolute offset. The buffer is transferred, not copied. */
  write(id: string, offset: number, data: Uint8Array<ArrayBuffer>): Promise<boolean> {
    // A transferred buffer must be exclusively ours, so a view into a larger
    // chunk buffer is copied out first.
    const owned =
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? data.buffer
        : data.slice().buffer;
    return call<boolean>({ op: "write", file: fileName(id), offset, data: owned }, [owned]);
  },

  async read(id: string, offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    const { data, read } = await call<{ data: ArrayBuffer; read: number }>({
      op: "read",
      file: fileName(id),
      offset,
      length,
    });
    return new Uint8Array(data, 0, read);
  },

  /** Streams the staged file through SHA-256 without holding it in memory. */
  hash: (id: string, length: number, onProgress?: (fraction: number) => void) =>
    call<string>({ op: "hash", file: fileName(id), length }, undefined, onProgress),

  size: (id: string) => call<number>({ op: "size", file: fileName(id) }),
  /** Releases one segment's disk space once a save has copied it out. */
  dropSegment: (id: string, index: number) =>
    call<boolean>({ op: "dropSegment", file: fileName(id), index }),
  /** Releases the exclusive handle so the main thread can read the file. */
  close: (id: string) => call<boolean>({ op: "close", file: fileName(id) }),
  remove: (id: string) => call<boolean>({ op: "remove", file: fileName(id) }),
  list: () => call<{ file: string; size: number }[]>({ op: "list" }),
};

/**
 * The staged bytes as one disk-backed `Blob`, for the download fallback.
 * Blob parts reference the underlying files rather than copying them, so this
 * stays flat in memory however many segments there are.
 */
export async function stagedFile(record: TransferRecord): Promise<Blob> {
  await staging.close(record.id);
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("staged", { create: true });

  const parts: File[] = [];
  for (let index = 0; index * SEGMENT_BYTES < record.size; index++) {
    const handle = await dir.getFileHandle(`${fileName(record.id)}.${index}`);
    parts.push(await handle.getFile());
  }
  return new Blob(parts, { type: record.mime });
}

/** Whether this browser can write straight to a location the user picks. */
export function savePickerSupported(): boolean {
  return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
}

/** Asks the browser for the storage durability a large transfer needs. */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist().catch(() => false);
}

export interface QuotaCheck {
  fits: boolean;
  quota: number;
  usage: number;
  available: number;
}

/**
 * Checked before a download starts, so a file that cannot possibly fit is
 * refused up front rather than at 90%.
 */
export async function checkQuota(needed: number): Promise<QuotaCheck | null> {
  if (!navigator.storage?.estimate) return null;
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();
  const available = Math.max(0, quota - usage);
  return { fits: available >= needed, quota, usage, available };
}

/** Drops one partial download: the staged bytes and the record together. */
export async function discardTransfer(id: string): Promise<void> {
  await staging.remove(id).catch(() => {});
  await deleteRecord(id);
}

/** Clears every partial download, including any staged file with no record. */
export async function discardAll(): Promise<void> {
  const records = await listTransfers();
  for (const record of records) await staging.remove(record.id).catch(() => {});
  // Sweep anything orphaned by an interrupted save or an older version.
  for (const entry of await staging.list().catch(() => [])) {
    const id = entry.file.replace(/\.part$/, "");
    await staging.remove(id).catch(() => {});
  }
  await clearRecords();
}
