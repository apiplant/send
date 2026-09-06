/**
 * Streaming SHA-256 (FIPS 180-4).
 *
 * `crypto.subtle.digest` only hashes a buffer you already hold in memory, which
 * rules it out for multi-gigabyte files on both ends: the sender hashes the file
 * slice by slice before offering it, and the receiver hashes chunks straight out
 * of IndexedDB. Both need to feed bytes in incrementally, so we keep our own
 * state across updates.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  #h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  #w = new Uint32Array(64);
  #block = new Uint8Array(64);
  #blockLength = 0;
  #totalLength = 0;

  update(data: Uint8Array): this {
    this.#totalLength += data.length;
    let offset = 0;

    // Top up a partial block left over from the previous update.
    if (this.#blockLength > 0) {
      const need = Math.min(64 - this.#blockLength, data.length);
      this.#block.set(data.subarray(0, need), this.#blockLength);
      this.#blockLength += need;
      offset = need;
      if (this.#blockLength === 64) {
        this.#compress(this.#block, 0);
        this.#blockLength = 0;
      }
    }

    while (offset + 64 <= data.length) {
      this.#compress(data, offset);
      offset += 64;
    }

    if (offset < data.length) {
      this.#block.set(data.subarray(offset), 0);
      this.#blockLength = data.length - offset;
    }
    return this;
  }

  /** Returns the lowercase hex digest. The instance must not be reused after. */
  hex(): string {
    const bitLength = this.#totalLength * 8;
    const padded = new Uint8Array(this.#blockLength < 56 ? 64 : 128);
    padded.set(this.#block.subarray(0, this.#blockLength), 0);
    padded[this.#blockLength] = 0x80;

    // Length goes in the last 8 bytes, big-endian. Files can exceed 2^32 bytes,
    // so the high word is computed rather than assumed zero.
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(padded.length - 4, bitLength >>> 0, false);

    for (let i = 0; i < padded.length; i += 64) this.#compress(padded, i);

    let out = "";
    for (const word of this.#h) out += word.toString(16).padStart(8, "0");
    return out;
  }

  #compress(data: Uint8Array, offset: number): void {
    const w = this.#w;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.#h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    const hs = this.#h;
    hs[0] = (hs[0] + a) >>> 0;
    hs[1] = (hs[1] + b) >>> 0;
    hs[2] = (hs[2] + c) >>> 0;
    hs[3] = (hs[3] + d) >>> 0;
    hs[4] = (hs[4] + e) >>> 0;
    hs[5] = (hs[5] + f) >>> 0;
    hs[6] = (hs[6] + g) >>> 0;
    hs[7] = (hs[7] + h) >>> 0;
  }
}

/** Hashes a Blob in slices, reporting progress as a 0..1 fraction. */
export async function hashBlob(
  blob: Blob,
  onProgress?: (fraction: number) => void,
  sliceSize = 8 * 1024 * 1024,
): Promise<string> {
  const hash = new Sha256();
  for (let offset = 0; offset < blob.size; offset += sliceSize) {
    const slice = blob.slice(offset, Math.min(offset + sliceSize, blob.size));
    hash.update(new Uint8Array(await slice.arrayBuffer()));
    onProgress?.(Math.min(1, (offset + sliceSize) / blob.size));
  }
  onProgress?.(1);
  return hash.hex();
}
