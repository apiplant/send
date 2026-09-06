/**
 * Getting a finished download out of the browser and onto the device.
 *
 * The copy runs forward, and each staged segment is deleted as soon as it has
 * been written to the destination. The staged copy therefore shrinks as the
 * destination grows, and the disk never holds much more than one full copy plus
 * a single 256 MB segment.
 *
 * This is what copying *backwards* and truncating was meant to achieve, and
 * could not: browsers charge storage by file length rather than allocated
 * blocks, so writing the last block first immediately reserves the destination's
 * full size (measured: 8 MB written at offset 40 MB cost 50.3 MB of quota).
 * Deleting whole segments does reclaim properly, which is why the staged file is
 * segmented in the first place — that and the 2000 MiB per-file ceiling.
 *
 * The trade is that saving is one-shot: an interrupted save leaves the segments
 * it already copied out deleted. That is recoverable rather than fatal, because
 * the bitmap is updated in step, so the transfer can be resumed for the part
 * that went missing.
 */

import { clearFrom, putTransfer, type TransferRecord } from "./idb";
import { savePickerSupported, staging, stagedFile, SEGMENT_BYTES } from "./staging";

/** Copied per pass. Large enough to be quick, small enough to bound a loss. */
const COPY_BLOCK = 8 * 1024 * 1024;

export type SaveMethod = "picker" | "download";

export interface SaveResult {
  method: SaveMethod;
  /** True when the staged copy is gone and the record can be retired. */
  reclaimed: boolean;
}

/**
 * Must be called synchronously from a click: the picker needs a user gesture.
 * Returns `null` if the user cancelled or the browser has no picker.
 */
export async function pickDestination(record: TransferRecord): Promise<FileSystemFileHandle | null> {
  if (!savePickerSupported()) return null;
  const picker = (
    globalThis as unknown as {
      showSaveFilePicker(options: {
        suggestedName?: string;
        types?: { description: string; accept: Record<string, string[]> }[];
      }): Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;

  try {
    return await picker({ suggestedName: record.name });
  } catch (error) {
    // AbortError just means the user changed their mind.
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

/**
 * Streams the staged file into `destination` in order. Progress is a 0..1
 * fraction of bytes copied.
 */
export async function saveToPickedFile(
  record: TransferRecord,
  destination: FileSystemFileHandle,
  onProgress?: (fraction: number) => void,
): Promise<SaveResult> {
  const writable = await destination.createWritable();
  let current = record;

  try {
    for (let offset = 0; offset < record.size; offset += COPY_BLOCK) {
      const length = Math.min(COPY_BLOCK, record.size - offset);
      const data = await staging.read(record.id, offset, length);
      if (data.length !== length) {
        throw new Error(`the staged file is short by ${length - data.length} bytes`);
      }
      await writable.write(data);

      // Once the copy has passed the end of a segment, that segment's disk space
      // is given back. The bitmap is updated in the same step so a later resume
      // knows those bytes are gone rather than skipping them.
      const finished = Math.floor((offset + length) / SEGMENT_BYTES);
      const previous = Math.floor(offset / SEGMENT_BYTES);
      if (finished > previous || offset + length === record.size) {
        const dropUpTo = offset + length === record.size ? finished : finished - 1;
        for (let index = previous; index <= dropUpTo; index++) {
          await staging.dropSegment(record.id, index);
        }
        current = { ...current, have: new Uint8Array(current.have) };
        clearFrom(current, 0, Math.min(record.size, (dropUpTo + 1) * SEGMENT_BYTES));
        await putTransfer(current);
      }

      onProgress?.((offset + length) / Math.max(1, record.size));
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }

  await staging.remove(record.id);
  return { method: "picker", reclaimed: true };
}

/**
 * The fallback: hand the whole staged file to the browser's downloader. It is
 * disk-backed, so nothing is held in memory, but the file does exist twice until
 * the staged copy is dropped.
 */
export async function saveByDownload(record: TransferRecord): Promise<SaveResult> {
  const file = await stagedFile(record);
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = record.name;
  anchor.click();

  // The download reads from the object URL lazily, so the staged file cannot be
  // removed immediately; the Storage tab can clear it once the copy is done.
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
  return { method: "download", reclaimed: false };
}
