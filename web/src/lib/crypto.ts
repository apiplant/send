/**
 * Content encryption for a transfer.
 *
 * The key comes from the SPAKE2 exchange in spake2.ts, which authenticates it
 * against the two words the user reads out — words the signalling server never
 * sees. This module only turns that shared secret into an AES-256-GCM key and
 * seals individual frames with it.
 *
 * WebRTC data channels are already encrypted in transit by DTLS, but DTLS ends
 * at the browser and its fingerprints are relayed by our server, so this layer
 * is what makes a hostile server unable to read or forge file bytes.
 */

const ENCODER = new TextEncoder();

/**
 * WebCrypto rejects views that might be backed by a SharedArrayBuffer, so the
 * byte helpers below are explicit about owning a plain ArrayBuffer.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** 96-bit GCM nonce: 4 random session bytes, then the frame's own coordinates. */
const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

export interface TransferKey {
  key: CryptoKey;
  /** Derived prefix that makes nonces unique across transfers reusing indices. */
  noncePrefix: Bytes;
  /** Short fingerprint both peers can compare out of band. */
  fingerprint: string;
}

/**
 * Expands the 128-bit secret SPAKE2 agreed on into everything the transfer
 * needs. The nameplate goes in the salt so two transfers that happened to use
 * the same words never share a key.
 */
export async function deriveTransferKey(
  sharedSecret: Bytes,
  nameplate: string,
): Promise<TransferKey> {
  const hkdf = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: ENCODER.encode(`apiplant-send/${nameplate}`),
        info: ENCODER.encode("apiplant-send/v1/content"),
      },
      hkdf,
      // 256 bits of AES key, 32 bits of nonce prefix, 64 bits of fingerprint.
      256 + 32 + 64,
    ),
  );

  const key = await crypto.subtle.importKey(
    "raw",
    derived.subarray(0, 32),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    key,
    noncePrefix: derived.slice(32, 36) as Bytes,
    fingerprint: Array.from(derived.subarray(36, 44))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .replace(/(.{4})(?=.)/g, "$1 "),
  };
}

/**
 * Nonce layout: `prefix(4) || chunkIndex(4) || offsetInChunk(4)`.
 * Every frame in a transfer has a unique (chunk, offset) pair, so no nonce is
 * ever reused under one key — the requirement GCM is unforgiving about.
 */
function nonce(prefix: Bytes, chunk: number, offset: number): Bytes {
  const bytes = new Uint8Array(new ArrayBuffer(NONCE_BYTES));
  bytes.set(prefix, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, chunk, false);
  view.setUint32(8, offset, false);
  return bytes;
}

/** Encrypts one frame, binding it to its header so frames cannot be reordered. */
export async function sealFrame(
  transferKey: TransferKey,
  chunk: number,
  offset: number,
  header: Bytes,
  plaintext: Bytes,
): Promise<ArrayBuffer> {
  return crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce(transferKey.noncePrefix, chunk, offset),
      additionalData: header,
    },
    transferKey.key,
    plaintext,
  );
}

export async function openFrame(
  transferKey: TransferKey,
  chunk: number,
  offset: number,
  header: Bytes,
  ciphertext: Bytes,
): Promise<Bytes> {
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: nonce(transferKey.noncePrefix, chunk, offset),
      additionalData: header,
    },
    transferKey.key,
    ciphertext,
  );
  return new Uint8Array(plain);
}
