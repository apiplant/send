/**
 * The synchronous OPFS access handle is not in this TypeScript version's DOM
 * library yet, though every browser we target ships it. Declared to the shape in
 * the File System standard.
 */
interface FileSystemSyncAccessHandle {
  read(buffer: BufferSource, options?: { at?: number }): number;
  write(buffer: BufferSource, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}
