/**
 * The peer-to-peer half: SDP/ICE setup and the range-based file protocol.
 *
 * The receiver drives everything. It knows which chunks it already has in
 * IndexedDB, so it asks for the ones it is missing and the sender simply serves
 * ranges — which is what makes a resumed transfer identical to a fresh one, and
 * what lets a second attempt pick up exactly where the first died.
 *
 * Wire format on the data channel:
 *   - JSON strings for control  ({"t":"want",...}, {"t":"chunk-end",...})
 *   - binary frames for data:  header(8) || payload
 *     header = uint32 chunk index || uint32 byte offset within that chunk.
 *
 * The payload is AES-GCM ciphertext when the transfer negotiated encryption, in
 * which case the header is also fed to GCM as additional data so a frame cannot
 * be moved or replayed; otherwise it is the raw bytes, protected only by the
 * data channel's own DTLS. Which one applies is settled during the handshake and
 * bounded by the server's policy — see `encryptionPolicy` in api.ts.
 */

import {
  iceServersNow,
  loadIceServers,
  postSignal,
  pollSignals,
  type FileMeta,
  type Role,
} from "./api";
import {
  deriveTransferKey,
  openFrame,
  sealFrame,
  TAG_BYTES,
  type Bytes,
  type TransferKey,
} from "./crypto";
import { decodeMac, encodeMac, macsEqual, startSpake2 } from "./spake2";
import type { EncryptionPolicy } from "./api";
import { Sha256 } from "./sha256";
import {
  chunkLength,
  chunkOffset,
  chunkSizeFor,
  markChunk,
  missingChunks,
  putTransfer,
  type TransferRecord,
} from "./idb";
import { staging } from "./staging";

/**
 * Frames are sized from what SCTP actually negotiated rather than the 16 KiB
 * every stack is guaranteed to accept: each frame costs a WebCrypto call and a
 * send, so larger frames measurably cut the encryption overhead. Capped at
 * 64 KiB, which every current browser handles and which keeps a stalled peer
 * from parking megabytes in the send buffer.
 */
const MIN_PIECE_SIZE = 8 * 1024;
const MAX_PIECE_SIZE = 64 * 1024;
const SAFE_MAX_MESSAGE = 16 * 1024;
const HEADER_SIZE = 8;
/** Chunks requested at once. Enough to keep the pipe full across a fat link. */
const WINDOW = 4;
const BUFFER_HIGH = 4 * 1024 * 1024;
const BUFFER_LOW = 1 * 1024 * 1024;

export type Phase =
  | "idle"
  | "waiting"
  | "connecting"
  | "transferring"
  | "verifying"
  | "complete"
  | "failed"
  | "cancelled";

export interface SecurityInfo {
  encrypted: boolean;
  fingerprint: string;
}

export interface TransferEvents {
  onPhase?(phase: Phase, detail?: string): void;
  onSecurity?(info: SecurityInfo): void;
  onProgress?(info: { bytes: number; total: number; bytesPerSecond: number }): void;
  onError?(error: Error): void;
  onComplete?(record?: TransferRecord): void;
}

export interface TransferHandle {
  cancel(): void;
}

/** Applies the server's policy to what the two peers would like to do. */
function resolveEncryption(policy: EncryptionPolicy, wanted: boolean): boolean {
  if (policy === "required") return true;
  if (policy === "off") return false;
  return wanted;
}

function describe(key: TransferKey | null): SecurityInfo {
  return key
    ? { encrypted: true, fingerprint: key.fingerprint }
    : { encrypted: false, fingerprint: "" };
}

/** Largest plaintext that still fits one SCTP message once framed and sealed. */
function pieceSizeFor(pc: RTCPeerConnection, encrypted: boolean): number {
  const limit = pc.sctp?.maxMessageSize || SAFE_MAX_MESSAGE;
  const budget = limit - HEADER_SIZE - (encrypted ? TAG_BYTES : 0);
  return Math.max(MIN_PIECE_SIZE, Math.min(MAX_PIECE_SIZE, budget));
}

/**
 * Waits for the data channel to hand everything to SCTP before the peer
 * connection is torn down. Closing straight after `send` drops whatever is
 * still queued — which is how the final "complete" used to go missing and leave
 * the sender reporting "the peer went away" on a transfer that had succeeded.
 */
function flush(channel: RTCDataChannel, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now();
    const check = () => {
      if (
        channel.readyState !== "open" ||
        channel.bufferedAmount === 0 ||
        performance.now() - started > timeoutMs
      ) {
        resolve();
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

function encodeHeader(chunk: number, offset: number): Bytes {
  const header = new Uint8Array(new ArrayBuffer(HEADER_SIZE));
  const view = new DataView(header.buffer);
  view.setUint32(0, chunk, false);
  view.setUint32(4, offset, false);
  return header;
}

/** Tracks a smoothed transfer rate so the UI does not flicker between frames. */
function rateMeter() {
  let last = performance.now();
  let lastBytes = 0;
  let rate = 0;
  return (bytes: number) => {
    const now = performance.now();
    const elapsed = now - last;
    if (elapsed >= 500) {
      const instant = ((bytes - lastBytes) * 1000) / elapsed;
      rate = rate === 0 ? instant : rate * 0.7 + instant * 0.3;
      last = now;
      lastBytes = bytes;
    }
    return rate;
  };
}

/** Shared plumbing: a peer connection wired to the signalling mailboxes. */
function connect(code: string, role: Role, abort: AbortController) {
  const pc = new RTCPeerConnection({ iceServers: iceServersNow() });
  // The full list (with any TURN relay) may still be loading. Apply it as soon
  // as it lands; ICE gathering only begins at setLocalDescription, and both
  // run* paths also await it before their first SDP, so this is belt-and-braces.
  void loadIceServers().then((servers) => {
    try {
      pc.setConfiguration({ iceServers: servers });
    } catch {
      /* setConfiguration is unsupported on old engines; the STUN list stands */
    }
  });
  const pending: RTCIceCandidateInit[] = [];
  let remoteReady = false;

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      void postSignal(code, role, { t: "ice", candidate: event.candidate.toJSON() }).catch(() => {});
    }
  };

  return {
    pc,
    /** Candidates can outrun the answer; hold them until there is somewhere to put them. */
    async addCandidate(candidate: RTCIceCandidateInit) {
      if (!remoteReady) {
        pending.push(candidate);
        return;
      }
      await pc.addIceCandidate(candidate).catch(() => {});
    },
    async setRemote(description: RTCSessionDescriptionInit) {
      await pc.setRemoteDescription(description);
      remoteReady = true;
      for (const candidate of pending.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
    },
    watchFailure(onFail: (reason: string) => void) {
      pc.onconnectionstatechange = () => {
        if (abort.signal.aborted) return;
        if (pc.connectionState === "failed") onFail("the peer connection dropped");
        if (pc.connectionState === "disconnected") onFail("the peer went away");
      };
    },
  };
}

/**
 * Sender: waits for a receiver, then serves whatever ranges it asks for.
 * Reads straight from the `File`, so nothing is buffered beyond one chunk.
 */
export function runSender(options: {
  file: File;
  /** The number the server allocated; the only part it knows. */
  nameplate: string;
  /** The two words the user reads out — the SPAKE2 password. */
  words: string;
  /** What this side wants; the server's policy still has the final say. */
  encrypt: boolean;
  policy: EncryptionPolicy;
  events: TransferEvents;
}): TransferHandle {
  const { file, nameplate, words, encrypt, policy, events } = options;
  const code = nameplate;
  const abort = new AbortController();
  const link = connect(code, "sender", abort);

  // Latched the moment the transfer succeeds. A finished transfer must never be
  // dragged back into "failed": the peer closing its connection is the normal
  // end of a successful transfer, not an error.
  let settled = false;
  /** True once every byte of the file has gone out, even if `complete` is late. */
  let allSent = false;

  const succeed = () => {
    if (settled) return;
    settled = true;
    events.onPhase?.("complete");
    events.onComplete?.();
    // Stop polling: the server session expires after the transfer, and a late
    // 404 would otherwise flip the finished UI into a failure.
    abort.abort();
    link.pc.close();
  };

  const fail = (message: string) => {
    if (settled) return;
    // The receiver has every byte and simply hung up before its acknowledgement
    // arrived — that is a completed transfer, not a dropped one.
    if (allSent) {
      succeed();
      return;
    }
    if (abort.signal.aborted) return;
    abort.abort();
    link.pc.close();
    events.onPhase?.("failed", message);
    events.onError?.(new Error(message));
  };

  void (async () => {
    try {
      // Make sure any TURN relay is on the connection before the first offer.
      try {
        link.pc.setConfiguration({ iceServers: await loadIceServers() });
      } catch {
        /* old engine without setConfiguration — the STUN fallback stands */
      }

      let key: TransferKey | null = null;
      let expectedPeerConfirmation: Uint8Array | null = null;
      let spakeMessage: string | undefined;
      let sent = 0;
      // Bytes the receiver already staged from an earlier attempt; the UI
      // reports progress on top of this base instead of restarting at zero.
      let base = 0;
      const meter = rateMeter();

      const channel = link.pc.createDataChannel("file", { ordered: true });
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = BUFFER_LOW;
      link.watchFailure(fail);

      /** Resolves once the peer has drained enough of the send buffer. */
      const drain = () =>
        channel.bufferedAmount <= BUFFER_HIGH
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              channel.addEventListener("bufferedamountlow", () => resolve(), { once: true });
            });

      // Requests are served one chunk at a time; the queue keeps the receiver's
      // window from turning into overlapping reads of the same file.
      const queue: number[] = [];
      let pumping = false;

      const pump = async () => {
        if (pumping) return;
        pumping = true;
        try {
          // Negotiated only once the connection is up, so it is read here
          // rather than when the channel was created.
          const pieceSize = pieceSizeFor(link.pc, key !== null);
          // Both sides derive this from the file size alone, so chunk indices
          // mean the same thing on each end without negotiating.
          const chunkSize = chunkSizeFor(file.size);

          while (queue.length > 0 && !abort.signal.aborted) {
            const index = queue.shift()!;
            const start = index * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());

            for (let offset = 0; offset < bytes.length; offset += pieceSize) {
              if (abort.signal.aborted) return;
              // The receiver may have gone away mid-chunk; stop rather than
              // throwing InvalidStateError on every remaining frame.
              if (channel.readyState !== "open") return fail("the receiver disconnected");
              await drain();
              const piece = bytes.subarray(offset, Math.min(offset + pieceSize, bytes.length));
              const header = encodeHeader(index, offset);
              const payload = key
                ? new Uint8Array(await sealFrame(key, index, offset, header, piece))
                : piece;

              const frame = new Uint8Array(HEADER_SIZE + payload.length);
              frame.set(header, 0);
              frame.set(payload, HEADER_SIZE);
              channel.send(frame);

              sent += piece.length;
              const done = Math.min(file.size, base + sent);
              if (done >= file.size) allSent = true;
              events.onProgress?.({
                bytes: done,
                total: file.size,
                bytesPerSecond: meter(sent),
              });
            }
            if (channel.readyState !== "open") return fail("the receiver disconnected");
            channel.send(JSON.stringify({ t: "chunk-end", index, length: end - start }));
          }
        } finally {
          pumping = false;
        }
      };

      channel.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const message = JSON.parse(event.data);
        if (message.t === "want") {
          if (settled) return;
          events.onPhase?.("transferring");
          if (typeof message.have === "number") base = Math.max(base, message.have);
          // Report the resumed position straight away. Without this the bar sits
          // at zero until the first frame goes out, so a resume looks as though
          // it restarted from the beginning.
          events.onProgress?.({
            bytes: Math.min(file.size, base + sent),
            total: file.size,
            bytesPerSecond: 0,
          });
          for (const index of message.chunks as number[]) {
            if (!queue.includes(index)) queue.push(index);
          }
          void pump().catch((error) => fail(String(error)));
        } else if (message.t === "complete") {
          // The receiver may already have had the whole file staged, in which
          // case no frame ever moved; show the bar full rather than empty.
          if (typeof message.have === "number") {
            events.onProgress?.({
              bytes: Math.min(file.size, Math.max(base + sent, message.have)),
              total: file.size,
              bytesPerSecond: 0,
            });
          }
          succeed();
        } else if (message.t === "bye") {
          fail(message.reason ?? "the receiver cancelled");
        }
      };

      events.onPhase?.("waiting");

      await pollSignals(
        code,
        "sender",
        async (message) => {
          if (message.t === "hello") {
            events.onPhase?.("connecting");

            // Both peers read the same server policy, so this normally just
            // confirms what the other side already assumed.
            const encrypted = resolveEncryption(policy, encrypt && message.encrypt !== false);

            let confirmation: string | undefined;
            if (encrypted) {
              const spake = await startSpake2("sender", words, nameplate);
              const result = await spake.finish(message.spake);
              key = await deriveTransferKey(result.sharedSecret, nameplate);
              confirmation = encodeMac(result.confirmation);
              expectedPeerConfirmation = result.expectedPeerConfirmation;
              spakeMessage = spake.message;
            }
            events.onSecurity?.(describe(key));

            const offer = await link.pc.createOffer();
            await link.pc.setLocalDescription(offer);
            await postSignal(code, "sender", {
              t: "offer",
              sdp: link.pc.localDescription,
              encrypt: encrypted,
              spake: spakeMessage,
              confirm: confirmation,
            });
          } else if (message.t === "answer") {
            // The receiver proves it derived the same key before any bytes move,
            // so a wrong code fails here with a clear message instead of as a
            // decryption error halfway through the file.
            if (expectedPeerConfirmation) {
              if (!message.confirm || !macsEqual(decodeMac(message.confirm), expectedPeerConfirmation)) {
                fail("the other device entered a different code");
                return;
              }
            }
            await link.setRemote(message.sdp);
          } else if (message.t === "ice") {
            await link.addCandidate(message.candidate);
          }
        },
        abort.signal,
      );
    } catch (error) {
      if (!abort.signal.aborted) fail(error instanceof Error ? error.message : String(error));
    }
  })();

  return {
    cancel() {
      if (settled) return;
      settled = true;
      abort.abort();
      link.pc.close();
      events.onPhase?.("cancelled");
    },
  };
}

/**
 * Receiver: asks for the chunks it is missing and writes each one to IndexedDB
 * as it completes, so progress survives the connection dying at any moment.
 */
export function runReceiver(options: {
  nameplate: string;
  words: string;
  meta: FileMeta;
  record: TransferRecord;
  policy: EncryptionPolicy;
  events: TransferEvents;
}): TransferHandle {
  const { nameplate, words, meta, policy, events } = options;
  const code = nameplate;
  let record = options.record;
  const abort = new AbortController();
  const link = connect(code, "receiver", abort);

  // Same latch as the sender: once every chunk is on disk the transfer has
  // succeeded, and a channel closing afterwards is just the peer hanging up.
  let settled = false;

  const fail = (message: string) => {
    if (settled) return;
    if (abort.signal.aborted) return;
    abort.abort();
    link.pc.close();
    events.onPhase?.("failed", message);
    events.onError?.(new Error(message));
  };

  void (async () => {
    try {
      // Make sure any TURN relay is on the connection before the first answer.
      try {
        link.pc.setConfiguration({ iceServers: await loadIceServers() });
      } catch {
        /* old engine without setConfiguration — the STUN fallback stands */
      }

      const spake = await startSpake2("receiver", words, nameplate);
      let key: TransferKey | null = null;
      const meter = rateMeter();

      // Partially received chunks live here; only whole chunks reach IndexedDB,
      // so a half-written chunk can never be mistaken for a stored one.
      const building = new Map<number, { bytes: Bytes; filled: number; expected: number }>();
      const outstanding = new Set<number>();
      let queue = missingChunks(record);

      link.watchFailure(fail);

      link.pc.ondatachannel = (event) => {
        const channel = event.channel;
        channel.binaryType = "arraybuffer";

        const requestMore = () => {
          const wanted: number[] = [];
          while (outstanding.size + wanted.length < WINDOW && queue.length > 0) {
            wanted.push(queue.shift()!);
          }
          if (wanted.length === 0) return;
          for (const index of wanted) outstanding.add(index);
          // `have` lets the sender report progress from where this file
          // actually is rather than from the start of the session.
          channel.send(JSON.stringify({ t: "want", chunks: wanted, have: record.receivedBytes }));
        };

        /**
         * Announces the finished transfer and only then tears the connection
         * down. The flush matters: closing straight after `send` discards the
         * queued message, and the sender would see the connection drop instead
         * of the completion it was waiting for.
         */
        const finish = async () => {
          if (settled) return;
          settled = true;
          if (channel.readyState === "open") {
            channel.send(JSON.stringify({ t: "complete", have: record.receivedBytes }));
            await flush(channel);
          }
          events.onPhase?.("complete");
          events.onComplete?.(record);
          abort.abort();
          link.pc.close();
        };

        channel.onopen = () => {
          events.onPhase?.("transferring");
          if (queue.length === 0) {
            // Everything was already on disk from an earlier attempt.
            void finish();
            return;
          }
          requestMore();
        };

        /**
         * Decrypting a frame is asynchronous, so handlers must not interleave:
         * a `chunk-end` that overtook the frames before it would see a
         * half-filled chunk and re-request it forever. Chaining the handlers
         * keeps them in arrival order.
         */
        let inOrder: Promise<void> = Promise.resolve();
        const handle = async (frame: MessageEvent) => {
          try {
            if (typeof frame.data === "string") {
              const message = JSON.parse(frame.data);
              if (message.t !== "chunk-end") return;

              const pendingChunk = building.get(message.index);
              if (!pendingChunk || pendingChunk.filled !== pendingChunk.expected) {
                // The sender finished a chunk we did not fully receive: ask again.
                building.delete(message.index);
                outstanding.delete(message.index);
                queue.unshift(message.index);
                requestMore();
                return;
              }

              building.delete(message.index);
              outstanding.delete(message.index);

              // Bytes first, then the bitmap: a record that claimed chunks the
              // staged file does not have would break the next resume.
              await staging.write(record.id, chunkOffset(record, message.index), pendingChunk.bytes);
              record = markChunk(record, message.index);
              await putTransfer(record);

              events.onProgress?.({
                bytes: record.receivedBytes,
                total: record.size,
                bytesPerSecond: meter(record.receivedBytes),
              });

              if (record.receivedBytes >= record.size) {
                await finish();
                return;
              }
              requestMore();
              return;
            }

            const data: Bytes = new Uint8Array(frame.data as ArrayBuffer);
            const header = data.subarray(0, HEADER_SIZE);
            const view = new DataView(data.buffer, data.byteOffset, HEADER_SIZE);
            const index = view.getUint32(0, false);
            const offset = view.getUint32(4, false);

            const payload = data.subarray(HEADER_SIZE);
            const plain = key ? await openFrame(key, index, offset, header, payload) : payload;

            let target = building.get(index);
            if (!target) {
              target = {
                bytes: new Uint8Array(new ArrayBuffer(chunkLength(record, index))),
                filled: 0,
                expected: chunkLength(record, index),
              };
              building.set(index, target);
            }
            target.bytes.set(plain, offset);
            target.filled += plain.length;
          } catch (error) {
            fail(
              error instanceof DOMException
                ? "a frame failed to decrypt — the code or link may not match"
                : String(error),
            );
          }
        };

        channel.onmessage = (frame) => {
          inOrder = inOrder.then(() => handle(frame));
        };

        channel.onclose = () => {
          if (!settled && !abort.signal.aborted && record.receivedBytes < record.size) {
            fail("the connection closed before the file finished");
          }
        };
      };

      events.onPhase?.("connecting");
      await postSignal(code, "receiver", {
        t: "hello",
        spake: spake.message,
        encrypt: policy !== "off",
      });

      await pollSignals(
        code,
        "receiver",
        async (message) => {
          if (message.t === "offer") {
            // The sender proposes; the policy decides whether that is allowed.
            if (policy === "required" && message.encrypt === false) {
              fail("the sender tried to skip encryption, which this server requires");
              return;
            }

            let confirmation: string | undefined;
            if (message.encrypt !== false) {
              const result = await spake.finish(message.spake);
              // A mismatched code shows up here, before the peers connect.
              if (
                !message.confirm ||
                !macsEqual(decodeMac(message.confirm), result.expectedPeerConfirmation)
              ) {
                fail("that code does not match the sending device");
                return;
              }
              key = await deriveTransferKey(result.sharedSecret, nameplate);
              confirmation = encodeMac(result.confirmation);
            }
            events.onSecurity?.(describe(key));

            await link.setRemote(message.sdp);
            const answer = await link.pc.createAnswer();
            await link.pc.setLocalDescription(answer);
            await postSignal(code, "receiver", {
              t: "answer",
              sdp: link.pc.localDescription,
              confirm: confirmation,
            });
          } else if (message.t === "ice") {
            await link.addCandidate(message.candidate);
          }
        },
        abort.signal,
      );
    } catch (error) {
      if (!abort.signal.aborted) fail(error instanceof Error ? error.message : String(error));
    }
  })();

  return {
    cancel() {
      if (settled) return;
      settled = true;
      abort.abort();
      link.pc.close();
      void postSignal(code, "receiver", { t: "bye", reason: "cancelled" }).catch(() => {});
      events.onPhase?.("cancelled");
    },
  };
}

/**
 * Re-reads the staged file and checks it against the sender's digest. The hash
 * is streamed inside the worker, so verifying 10 GB costs 8 MB of memory.
 */
export async function verifyStaged(
  record: TransferRecord,
  expectedSha256: string,
  onProgress?: (fraction: number) => void,
): Promise<{ ok: boolean; digest: string }> {
  const staged = await staging.size(record.id);
  if (staged !== record.size) {
    throw new Error(`the staged file is ${staged} bytes, expected ${record.size}`);
  }
  const digest = await staging.hash(record.id, record.size, onProgress);
  return { ok: digest === expectedSha256, digest };
}

export type { FileMeta };
