# apiplant-send

Peer-to-peer file transfer in the browser. Pick a file, read a short code to the
other device, and the bytes go straight from one browser to the other over
WebRTC — end-to-end encrypted, resumable, and checksum-verified on arrival.

- **`server/`** — a single Rust binary (ntex) that is both the signalling server
  and, optionally, the static host for the app.
- **`web/`** — a Solid.js 2 + Tailwind app. Served by the Rust binary or deployed
  as a static site pointed at a remote signalling server.

## How it works

1. The sender picks a file. The browser streams it through an incremental
   SHA-256 and registers `{name, size, mime, sha256}` with the signalling server.
2. The server returns a **nameplate** — the lowest free number — and the browser
   appends two words it picks itself from the PGP word list, the vocabulary
   magic-wormhole uses, chosen so a code survives being read aloud:
   `7-adroitness-aardvark`. The app also renders a QR code for
   `https://<host>/#7-adroitness-aardvark`.
3. The receiver types the code or opens the link. The peers run SPAKE2 over those
   two words, then exchange SDP and ICE through the server's per-session
   mailboxes and connect directly over an `RTCDataChannel`.
4. The receiver drives the transfer by **requesting chunk ranges** it does not
   already have. Chunks are written straight into a staged file in the Origin
   Private File System, so a dropped connection only costs what was in flight:
   ask the sender for a fresh code and the download resumes from the first
   missing chunk.
5. When every chunk is present, the staged file is streamed through SHA-256 and
   compared with the sender's. The receiver is told plainly whether it verified
   or is corrupted, and only a verified file is handed to the browser.
6. A verified file downloads itself — there is nothing to click. Entering a code
   starts the transfer, and finishing it starts the download, so the whole
   receiving side is one field and one button.

The staged copy outlives that download, so a received file stays in the Storage
tab until it is cleared. That is also where it can be written out again, and
there the save picker is available: writing through it streams the file to the
chosen location and releases each staged segment as it passes, so the disk never
holds two full copies. The automatic download cannot use the picker, which needs
a user gesture it does not have.

The signalling server never sees file bytes — only the metadata above and the
opaque SDP/ICE blobs it relays.

### Encryption

Data channels are already encrypted in transit by DTLS, but DTLS terminates at
the browser and its fingerprints are exchanged through the signalling server — so
a hostile server could stand in the middle. Every transfer therefore also gets
its own AES-256-GCM key, authenticated by the code itself:

- The server allocates **only the nameplate**, the number at the front. The two
  words are chosen in the browser and never sent to it — not on the wire, and not
  in the share link, whose fragment browsers do not transmit.
- Those words are the password for **SPAKE2** over P-256 (RFC 9382, ciphersuite
  SPAKE2-P256-SHA256-HKDF-HMAC, using the RFC's published `M` and `N`). Both
  sides send a blinded curve point, derive the same secret only if the words
  match, and exchange confirmation MACs before any file bytes move — so a
  mistyped code fails immediately with "that code does not match", rather than as
  a decryption error halfway through.
- The agreed secret is expanded with HKDF into the content key and a nonce
  prefix. Each frame is sealed with a nonce derived from its position and
  authenticated against its own header, so frames cannot be reordered or replayed.

A PAKE is what makes the short code sufficient. Two words is only 65,536
combinations, so mixing them into an ordinary key exchange would be no protection
at all — anyone who captured a frame could try every pair offline in
milliseconds. SPAKE2 makes each guess cost a full online exchange: an attacker
gets one try in 65,536 per attempt and learns nothing from a failure. A typed
code and a scanned QR are therefore equally strong.

The UI still shows a short fingerprint of the derived key, which both devices can
compare if you want to see the agreement for yourself.

**Cost:** negligible. AES-GCM at the 64 KiB frame the connection negotiates runs
at **923 MB/s** in-browser (48 MB sealed and opened in 52 ms), far above any
transfer a real network will sustain, and the SPAKE2 handshake is a one-off
~30 ms dominated by the PBKDF2 stretch of the words.

End-to-end transfer timings over loopback are bimodal — repeated runs land near
either 1.0 s or 2.2 s for 48 MB in *both* modes — so they measure WebRTC
scheduling rather than encryption; `npm run bench` prints both so you can see
that for yourself. Frame size, on the other hand, mattered a great deal: at a
conservative 8 KiB frame the same transfer was 58% slower, because each frame
costs a WebCrypto call. Frames are therefore sized from the SCTP
`maxMessageSize` the connection negotiated, capped at 64 KiB.

If you would still rather not pay for it, `APIPLANT_SEND_ENCRYPTION` controls the
policy and the peers negotiate within it during the handshake:

| Value | Behaviour |
| --- | --- |
| `required` (default) | Every transfer is end-to-end encrypted. A receiver refuses a sender that proposes otherwise. |
| `optional` | The sending device chooses, with a toggle in the UI. |
| `off` | No end-to-end layer, and no SPAKE2; transfers rely on the data channel's DTLS alone. |

## Large files

Nothing in the receive path scales with file size in memory. Measured in Chrome:

| | 8 GB, staging path only | 1.25 GB, full transfer over WebRTC |
| --- | --- | --- |
| peak JS heap | 6 MB | 171 MB |
| staged at | 733 MB/s | 42.7 MB/s end to end |
| verified at | 70 MB/s | included above |
| peak disk vs file size | 1.0x | 1.18x, settling to 1.0x |

The 171 MB in a real transfer is WebRTC buffers and the frame window, not the
file — it does not grow with file size. Reproduce with `npm run test:scale` and
`npm run test:large`.

- Bytes go into the **Origin Private File System**, written at their absolute
  offset through a `FileSystemSyncAccessHandle` in a worker. OPFS was chosen over
  the File System Access pickers because it exists in every current browser
  including iOS, where the pickers do not exist at all.
- The staged bytes are split into **256 MB segments**. This is not a tuning
  choice: a single OPFS file cannot grow past **2000 MiB** in Chrome — the write
  returns error code `-8` with quota to spare — so one file per transfer would
  cap every download at 2 GB. Segments also let the save reclaim space as it
  goes, below.
- IndexedDB holds only metadata and a chunk bitmap — a few kilobytes whatever the
  file size.
- Verification streams the staged file through SHA-256 in 8 MB blocks inside the
  worker, so a 10 GB file is verified in 8 MB of memory.
- Chunks are 256 KB below 1 GB and 1 MB above it, keeping the bitmap and the
  number of database writes reasonable for very large transfers.
- Short writes are treated as errors rather than ignored. `write()` returns a
  byte count, and a partial write is how both quota exhaustion and the per-file
  ceiling announce themselves; ignoring it turns them into silent corruption that
  only the final checksum catches.

**Quota.** Browsers grant roughly 60% of free disk to an origin — 10.7 GB on the
machine this was developed on. The receiver checks `navigator.storage.estimate()`
when you enter a code and says up front if the file cannot fit, rather than
failing at 90%, and calls `navigator.storage.persist()` so a half-finished
transfer is less likely to be evicted under pressure.

**Saving.** The copy runs forward and deletes each staged segment as soon as it
has been written out, so the disk never holds two full copies — just the file
plus at most one segment (measured at 1.18x peak for a 1.25 GB file, against
~1.9x before segments were introduced). Copying *backwards* and truncating was the first
attempt and does not work: browsers charge storage by file length rather than
allocated blocks, so writing the last block first immediately reserves the
destination's full size (measured: 8 MB written at offset 40 MB cost 50.3 MB of
quota). Deleting whole segments does reclaim properly.

The trade is that saving is one-shot: an interrupted save leaves already-copied
segments deleted. That is recoverable rather than fatal — the bitmap is cleared
in step, so the transfer resumes for exactly the part that went missing.

On browsers without a save picker (Firefox, anything on iOS) the file goes
through a normal download instead. The segments are handed over as one `Blob`,
which references them rather than copying, so nothing is held in memory — but the
staged copy does have to be cleared from the Storage tab afterwards.

**A note on testing this.** Both large-file tests put the browser profile and
their scratch files on real disk on purpose. `/tmp` is tmpfs on many Linux
systems, and staging several gigabytes into RAM gets the browser OOM-killed,
which looks exactly like an application bug and is not one.

## Running

```sh
# terminal 1 — signalling server on :8080
cd server && cargo run --release

# terminal 2 — frontend dev server on :3000 (proxies /api to :8080)
cd web && npm install && npm run dev
```

Single-binary deployment:

```sh
cd web && npm install && npm run build   # emits ../server/static
cd ../server && cargo run --release      # serves the app and /api on :8080
```

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `APIPLANT_SEND_ADDR` | `0.0.0.0:8080` | listen address |
| `APIPLANT_SEND_STATIC` | `./static` | directory served at `/`, if it exists |
| `APIPLANT_SEND_TTL` | `3600` | seconds an idle session is kept |
| `APIPLANT_SEND_ENCRYPTION` | `required` | `required`, `optional` or `off` |
| `APIPLANT_SEND_TURN` | _(unset)_ | JSON array of `RTCIceServer` objects appended to STUN, served at `/api/turn` |

The frontend can point at a remote signalling server by building with
`VITE_API_BASE=https://signal.example.com`.

### ICE / TURN

The app fetches its ICE servers from the signalling server at `/api/turn` — a
STUN server (`stun:stun.l.google.com:19302`) plus whatever `APIPLANT_SEND_TURN`
holds, so a relay can be added by server config with no rebuild. `VITE_ICE_SERVERS`
still hard-codes a list at build time and is used only if `/api/turn` is
unreachable.

TURN is **disabled by default**, both on the server (`APIPLANT_SEND_TURN` unset)
and in the app (`VITE_TURN_ENABLED` unset). While it is off the app shows a
notice that STUN-only transfers can fail behind corporate VPNs or between mobile
networks. Set `VITE_TURN_ENABLED=true` at build time once a relay is deployed;
the app also hides the notice on its own if `/api/turn` reports a relay.

STUN alone connects two peers only when at least one has a non-symmetric NAT.
Most mobile carriers use symmetric CGNAT, so **a TURN relay is required for a
phone on cellular to transfer with a machine on another network**. Set
`APIPLANT_SEND_TURN` to something like

```json
[{"urls":["turn:turn.example.com:3478?transport=udp","turns:turn.example.com:5349?transport=tcp"],
  "username":"user","credential":"pass"}]
```

Relayed bytes stay end-to-end encrypted; the relay only ever sees ciphertext.

## Tests

```sh
cd server && cargo test        # nameplate allocation and parsing
cd web && npm run typecheck
cd web && npm test             # streaming SHA-256 vs node's, SPAKE2, frame sealing
cd web && npm run build && npm run test:e2e   # two real browsers, real WebRTC
cd web && npm run test:scale   # 3 GB staged, hashed and reclaimed (SIZE_MB to change)
cd web && npm run test:large   # one multi-GB transfer end to end over real WebRTC
```

The end-to-end suite drives two browser contexts through a complete transfer, a
mistyped code that must be refused before any bytes move, a QR-link transfer, an
interrupted transfer resumed under a second code after a page reload, a save
through the file picker and a save through the download fallback, and a run with
the end-to-end layer switched off — asserting the saved file is byte-identical
every time. `test:large` then does one multi-gigabyte transfer, checking that peak
JS heap stays flat and that random slices of the saved file match the source.

## Signalling API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | liveness and live session count |
| `GET` | `/api/config` | the deployment's encryption policy |
| `POST` | `/api/sessions` | register a file offer, receive a nameplate |
| `GET` | `/api/sessions/{nameplate}` | look up the offered file's metadata |
| `POST` | `/api/sessions/{nameplate}/signal?role=` | hand one SDP/ICE message to the peer |
| `GET` | `/api/sessions/{nameplate}/poll?role=` | long-poll this role's mailbox (~20s) |
| `DELETE` | `/api/sessions/{nameplate}` | retire a nameplate |

Every path is keyed by the nameplate alone. The server has no way to learn the
two words, which is what lets the code authenticate the key exchange against the
server itself.

Signalling is plain REST rather than WebSockets: a transfer needs a handful of
messages, so a long poll costs less than holding a socket open per peer.
