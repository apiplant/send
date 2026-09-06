/**
 * Metadata for partially received files.
 *
 * The bytes themselves live in the Origin Private File System (see staging.ts);
 * this store holds only what is needed to resume — the file's identity and a
 * bitmap of which chunks have arrived. That keeps the record a few kilobytes
 * regardless of whether the transfer is 4 MB or 10 GB.
 */

const DB_NAME = "apiplant-send";
const DB_VERSION = 2;
const TRANSFERS = "transfers";

/** Chunk size, and so the unit the receiver requests and resumes at. */
const SMALL_CHUNK = 256 * 1024;
const LARGE_CHUNK = 1024 * 1024;
const LARGE_FILE = 1024 * 1024 * 1024;

/**
 * Big files get big chunks: at 256 KB a 10 GB transfer would need 40,960 bitmap
 * updates, and each one costs a database write.
 */
export function chunkSizeFor(size: number): number {
  return size > LARGE_FILE ? LARGE_CHUNK : SMALL_CHUNK;
}

export interface TransferRecord {
  /** The file's SHA-256 — the same file always resumes into the same record. */
  id: string;
  name: string;
  size: number;
  mime: string;
  chunkSize: number;
  chunkCount: number;
  /** Bitmap of chunks already staged, one bit per chunk, LSB first. */
  have: Uint8Array;
  receivedBytes: number;
  createdAt: number;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (!db.objectStoreNames.contains(TRANSFERS)) {
          db.createObjectStore(TRANSFERS, { keyPath: "id" });
        }
        // Version 1 kept file bytes in a "chunks" store. They cannot be migrated
        // into OPFS from here, so the partials are dropped rather than left
        // orphaned; the transfers themselves can simply be resumed.
        if (event.oldVersion < 2 && db.objectStoreNames.contains("chunks")) {
          db.deleteObjectStore("chunks");
          request.transaction?.objectStore(TRANSFERS).clear();
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function hasChunk(record: TransferRecord, index: number): boolean {
  return (record.have[index >> 3] & (1 << (index & 7))) !== 0;
}

export function missingChunks(record: TransferRecord): number[] {
  const missing: number[] = [];
  for (let i = 0; i < record.chunkCount; i++) if (!hasChunk(record, i)) missing.push(i);
  return missing;
}

/** Byte length of a given chunk — the last one is usually short. */
export function chunkLength(record: TransferRecord, index: number): number {
  return Math.min(record.chunkSize, record.size - index * record.chunkSize);
}

export function chunkOffset(record: TransferRecord, index: number): number {
  return index * record.chunkSize;
}

/** Marks a chunk present, in place, and returns the bytes that added. */
export function markChunk(record: TransferRecord, index: number): TransferRecord {
  if (hasChunk(record, index)) return record;
  const have = new Uint8Array(record.have);
  have[index >> 3] |= 1 << (index & 7);
  return {
    ...record,
    have,
    receivedBytes: Math.min(record.size, record.receivedBytes + chunkLength(record, index)),
    updatedAt: Date.now(),
  };
}

/**
 * Forgets the chunks in `[from, to)`, used as a save copies segments out of the
 * staged file and deletes them.
 */
export function clearFrom(record: TransferRecord, from: number, to: number): void {
  const first = Math.floor(from / record.chunkSize);
  const last = Math.ceil(to / record.chunkSize);
  for (let index = first; index < last && index < record.chunkCount; index++) {
    if (!hasChunk(record, index)) continue;
    record.have[index >> 3] &= ~(1 << (index & 7));
    record.receivedBytes = Math.max(0, record.receivedBytes - chunkLength(record, index));
  }
}

export function newRecord(meta: { sha256: string; name: string; size: number; mime: string }) {
  const chunkSize = chunkSizeFor(meta.size);
  const chunkCount = Math.max(1, Math.ceil(meta.size / chunkSize));
  return {
    id: meta.sha256,
    name: meta.name,
    size: meta.size,
    mime: meta.mime || "application/octet-stream",
    chunkSize,
    chunkCount,
    have: new Uint8Array(Math.ceil(chunkCount / 8)),
    receivedBytes: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } satisfies TransferRecord;
}

export async function getTransfer(id: string): Promise<TransferRecord | undefined> {
  const db = await open();
  return promisify(db.transaction(TRANSFERS, "readonly").objectStore(TRANSFERS).get(id));
}

export async function putTransfer(record: TransferRecord): Promise<void> {
  const db = await open();
  const tx = db.transaction(TRANSFERS, "readwrite");
  tx.objectStore(TRANSFERS).put({ ...record, updatedAt: Date.now() });
  await done(tx);
}

export async function listTransfers(): Promise<TransferRecord[]> {
  const db = await open();
  const all = await promisify(
    db.transaction(TRANSFERS, "readonly").objectStore(TRANSFERS).getAll() as IDBRequest<
      TransferRecord[]
    >,
  );
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteRecord(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(TRANSFERS, "readwrite");
  tx.objectStore(TRANSFERS).delete(id);
  await done(tx);
}

export async function clearRecords(): Promise<void> {
  const db = await open();
  const tx = db.transaction(TRANSFERS, "readwrite");
  tx.objectStore(TRANSFERS).clear();
  await done(tx);
}

/** What the browser reports for this origin, for the storage tab. */
export async function quota(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}
