/**
 * SPAKE2 over P-256, per RFC 9382 — the balanced PAKE magic-wormhole uses.
 *
 * The point of a PAKE here: the signalling server allocates only the leading
 * nameplate, while the two words are chosen in the browser and never leave it.
 * Those words are a low-entropy secret (65,536 combinations), so mixing them
 * into an ordinary ECDH would be no protection at all — anyone who captured a
 * frame could try every pair offline in milliseconds. SPAKE2 makes each guess
 * cost a full online exchange, so an attacker gets one try in 65,536 per
 * attempt, and a failed guess yields nothing to grind on afterwards.
 *
 * Ciphersuite: SPAKE2-P256-SHA256-HKDF-HMAC.
 */

import { p256 } from "@noble/curves/nist.js";

const Point = p256.Point;
const ORDER = Point.Fn.ORDER;

/**
 * The fixed points from RFC 9382 §4 for P-256, generated from the curve's
 * "point generation seed" so that nobody knows their discrete logs.
 */
const M = Point.fromHex("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f");
const N = Point.fromHex("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49");

/** Fixed, non-secret identities. Including them rules out unknown key-share attacks. */
const IDENTITY_A = new TextEncoder().encode("apiplant-send/sender");
const IDENTITY_B = new TextEncoder().encode("apiplant-send/receiver");

/** Scalars are 32 bytes on P-256; `w` is padded to that so its length leaks nothing. */
const SCALAR_BYTES = 32;
/** RFC 9382 suggests hashing 64 bits beyond the group size before reducing. */
const W_HASH_BYTES = SCALAR_BYTES + 8;
/** PBKDF2 stands in for the spec's memory-hard function; WebCrypto has no scrypt. */
const PBKDF2_ITERATIONS = 150_000;

export type Spake2Role = "sender" | "receiver";
type Bytes = Uint8Array<ArrayBuffer>;

export interface Spake2Result {
  /** The shared secret, Ke. Everything else is derived from this. */
  sharedSecret: Bytes;
  /** The MAC this side must send so the peer knows the code matched. */
  confirmation: Bytes;
  /** The MAC this side must receive; anything else means the codes differ. */
  expectedPeerConfirmation: Bytes;
}

export interface Spake2Session {
  /** This side's public element, `pA` or `pB`, to hand to the peer. */
  message: string;
  finish(peerMessage: string): Promise<Spake2Result>;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(text: string): Bytes {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `len(S) || S`, with the length as an eight-byte little-endian number. */
function withLength(value: Bytes): Bytes {
  const out = new Uint8Array(new ArrayBuffer(8 + value.length));
  new DataView(out.buffer).setBigUint64(0, BigInt(value.length), true);
  out.set(value, 8);
  return out;
}

function concat(...parts: Bytes[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntToBytes(value: bigint, length: number): Bytes {
  const out = new Uint8Array(new ArrayBuffer(length));
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

/**
 * Turns the spoken words into the SPAKE2 scalar `w`. The nameplate is the salt,
 * so the same words used on two different transfers derive different scalars.
 */
async function deriveW(password: string, nameplate: string): Promise<bigint> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const stretched = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new TextEncoder().encode(`apiplant-send/spake2/${nameplate}`),
        iterations: PBKDF2_ITERATIONS,
      },
      key,
      W_HASH_BYTES * 8,
    ),
  );
  // Reducing a value 64 bits wider than the group removes the modulo bias.
  return bytesToBigInt(stretched) % ORDER;
}

async function hkdf(secret: Bytes, info: string, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(info),
      },
      key,
      bytes * 8,
    ),
  );
}

async function hmac(key: Bytes, message: Bytes): Promise<Bytes> {
  const macKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", macKey, message));
}

/**
 * Starts an exchange. The returned `message` is safe to send in the clear: it is
 * this side's public element blinded by `w`, and reveals nothing about the words
 * to anyone who does not already know them.
 */
export async function startSpake2(
  role: Spake2Role,
  words: string,
  nameplate: string,
): Promise<Spake2Session> {
  const w = await deriveW(words, nameplate);
  // A (the sender) blinds with M, B (the receiver) with N; each unblinds with
  // the other's point. Fixed roles are what keep the two sides from colliding.
  const own = role === "sender" ? M : N;
  const peer = role === "sender" ? N : M;

  const secret = p256.utils.randomSecretKey();
  const x = bytesToBigInt(secret) % ORDER;
  const element = Point.BASE.multiply(x).add(own.multiply(w));
  const message = element.toBytes(false) as Bytes;

  return {
    message: toBase64(message),
    async finish(peerMessage: string): Promise<Spake2Result> {
      const peerElement = Point.fromBytes(fromBase64(peerMessage));
      peerElement.assertValidity();

      // K = x * (peer element - w * peer point). P-256 has cofactor 1, so the
      // spec's multiplication by h is a no-op here.
      const K = peerElement.subtract(peer.multiply(w)).multiply(x);

      const peerBytes = peerElement.toBytes(false) as Bytes;
      const pA = role === "sender" ? message : peerBytes;
      const pB = role === "sender" ? peerBytes : message;

      const transcript = concat(
        withLength(IDENTITY_A),
        withLength(IDENTITY_B),
        withLength(pA as Bytes),
        withLength(pB as Bytes),
        withLength(K.toBytes(false) as Bytes),
        withLength(bigIntToBytes(w, SCALAR_BYTES)),
      );

      // Hash(TT) = Ke || Ka, each half the digest length.
      const hashed = new Uint8Array(await crypto.subtle.digest("SHA-256", transcript));
      const Ke = hashed.slice(0, 16) as Bytes;
      const Ka = hashed.slice(16) as Bytes;

      const confirmationKeys = await hkdf(Ka, "ConfirmationKeys", 32);
      const KcA = confirmationKeys.slice(0, 16) as Bytes;
      const KcB = confirmationKeys.slice(16) as Bytes;

      const cA = await hmac(KcA, transcript);
      const cB = await hmac(KcB, transcript);

      return {
        sharedSecret: Ke,
        confirmation: role === "sender" ? cA : cB,
        expectedPeerConfirmation: role === "sender" ? cB : cA,
      };
    },
  };
}

/** Constant-time-ish comparison for the confirmation MACs. */
export function macsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export { toBase64 as encodeMac, fromBase64 as decodeMac };
