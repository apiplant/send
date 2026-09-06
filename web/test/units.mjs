/**
 * Checks the parts we implement ourselves rather than delegate: the streaming
 * SHA-256 (against Node's), the SPAKE2 key agreement, and the frame sealing that
 * rides on it.
 *
 * Run with `npm test`, which transpiles the TypeScript sources first.
 */
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { Sha256 } from "./build/sha256.js";

globalThis.crypto ??= webcrypto;
globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");

const { deriveTransferKey, sealFrame, openFrame } = await import("./build/crypto.js");
const { startSpake2, macsEqual, decodeMac } = await import("./build/spake2.js");
const { parseCode, pickWords, ODD_WORDS, EVEN_WORDS } = await import("./build/words.js");

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

console.log("streaming sha-256");
for (const [input, expected] of [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
]) {
  const got = new Sha256().update(new TextEncoder().encode(input)).hex();
  check(`vector ${JSON.stringify(input.slice(0, 12))}`, got === expected, got);
}

{
  const hash = new Sha256();
  const block = new Uint8Array(1000).fill(0x61);
  for (let i = 0; i < 1000; i++) hash.update(block);
  check(
    "one million 'a'",
    hash.hex() === "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  );
}

// The app always hashes in irregular pieces — file slices on one side, stored
// chunks on the other — so the split must never change the digest.
{
  let ok = true;
  for (let trial = 0; trial < 20 && ok; trial++) {
    const data = randomBytes(1 + Math.floor(Math.random() * 300000));
    const streamed = new Sha256();
    for (let offset = 0; offset < data.length; ) {
      const size = 1 + Math.floor(Math.random() * 5000);
      streamed.update(data.subarray(offset, offset + size));
      offset += size;
    }
    ok = streamed.hex() === createHash("sha256").update(data).digest("hex");
  }
  check("20 random split points match node's digest", ok);
}

console.log("SPAKE2 key agreement");
const NAMEPLATE = "7";
const WORDS = "adroitness-aardvark";
{
  const sender = await startSpake2("sender", WORDS, NAMEPLATE);
  const receiver = await startSpake2("receiver", WORDS, NAMEPLATE);
  const a = await sender.finish(receiver.message);
  const b = await receiver.finish(sender.message);

  check("both peers agree on the secret", same(a.sharedSecret, b.sharedSecret));
  check(
    "each side's confirmation is what the other expects",
    macsEqual(a.confirmation, b.expectedPeerConfirmation) &&
      macsEqual(b.confirmation, a.expectedPeerConfirmation),
  );
  check("the blinded element is a full P-256 point", decodeMac(sender.message).length === 65);

  // A wrong word must fail confirmation, before any bytes move.
  const wrong = await startSpake2("receiver", "adroitness-absurd", NAMEPLATE);
  const wrongSide = await wrong.finish(sender.message);
  const senderSide = await sender.finish(wrong.message);
  check(
    "a wrong word breaks confirmation",
    !macsEqual(wrongSide.confirmation, senderSide.expectedPeerConfirmation),
  );
  check("a wrong word yields a different secret", !same(wrongSide.sharedSecret, senderSide.sharedSecret));

  const elsewhere = await startSpake2("receiver", WORDS, "8");
  const elsewhereSide = await elsewhere.finish(sender.message);
  const senderElsewhere = await sender.finish(elsewhere.message);
  check(
    "the nameplate is bound into the exchange",
    !same(elsewhereSide.sharedSecret, senderElsewhere.sharedSecret),
  );

  // Roles are asymmetric by design: two senders must never agree.
  const impostor = await startSpake2("sender", WORDS, NAMEPLATE);
  const clash = await impostor.finish(sender.message);
  const against = await sender.finish(impostor.message);
  check("two peers in the same role do not agree", !same(clash.sharedSecret, against.sharedSecret));
}

console.log("content keys and frame sealing");
{
  const sender = await startSpake2("sender", WORDS, NAMEPLATE);
  const receiver = await startSpake2("receiver", WORDS, NAMEPLATE);
  const a = await deriveTransferKey((await sender.finish(receiver.message)).sharedSecret, NAMEPLATE);
  const b = await deriveTransferKey((await receiver.finish(sender.message)).sharedSecret, NAMEPLATE);

  check("both sides derive the same fingerprint", a.fingerprint === b.fingerprint, a.fingerprint);

  const header = new Uint8Array([0, 0, 0, 3, 0, 0, 32, 0]);
  const plaintext = new Uint8Array(randomBytes(64 * 1024));
  const sealed = new Uint8Array(await sealFrame(a, 3, 8192, header, plaintext));

  check("a frame round-trips", same(await openFrame(b, 3, 8192, header, sealed), plaintext));
  check("the ciphertext carries a GCM tag", sealed.length === plaintext.length + 16);

  const rewritten = new Uint8Array(header);
  rewritten[3] = 4;
  check(
    "a rewritten header is rejected",
    await openFrame(b, 3, 8192, rewritten, sealed).then(
      () => false,
      () => true,
    ),
  );
}

console.log("codes");
{
  check("a picked code parses back", parseCode(`7-${pickWords()}`) !== null);
  check("typing is forgiving", parseCode(" 7 Adroitness_Aardvark ")?.words === "adroitness-aardvark");
  check("nonsense is rejected", parseCode("hello") === null);
  check("the word lists are complete", ODD_WORDS.length === 256 && EVEN_WORDS.length === 256);
  check("the halves are disjoint", new Set([...ODD_WORDS, ...EVEN_WORDS]).size === 512);
}

console.log(failures === 0 ? "\nall unit checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
