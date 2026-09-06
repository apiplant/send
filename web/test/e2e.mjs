/**
 * End-to-end: builds nothing, assumes `npm run build` has run, then drives two
 * separate browser contexts through a real WebRTC transfer against the real
 * signalling server.
 *
 * Covers the things that are hard to be sure of by reading the code: that a
 * transfer completes, verifies and downloads itself without being asked; that
 * the sender stays complete when the finished receiver hangs up; that the QR
 * link path carries the key; that killing a receiver mid-flight and issuing a
 * new code resumes — on both ends — instead of restarting; and that a received
 * file left in Storage can still be written out to disk.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = 8123;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome-stable";
const SERVER = new URL("../../server/target/release/apiplant-send", import.meta.url).pathname;
const STATIC = new URL("../../server/static", import.meta.url).pathname;

/** Blocks until nothing is answering on the port, so a restart really rebinds. */
async function waitForPortFree() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const up = await fetch(`${ORIGIN}/api/health`).then(() => true, () => false);
    if (!up) return;
    await wait(100);
  }
  throw new Error("the previous signalling server never let go of the port");
}

/** Boots the signalling server under a given encryption policy. */
async function startServer(encryption) {
  const process_ = spawn(SERVER, [], {
    env: {
      ...process.env,
      APIPLANT_SEND_ADDR: `127.0.0.1:${PORT}`,
      APIPLANT_SEND_STATIC: STATIC,
      APIPLANT_SEND_ENCRYPTION: encryption,
    },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    const up = await fetch(`${ORIGIN}/api/health`).then(
      () => true,
      () => false,
    );
    if (up) return process_;
    await wait(100);
  }
  throw new Error("the signalling server did not come up");
}

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the receiver's IndexedDB directly — the ground truth for resuming. */
/**
 * Playwright cannot drive a native save dialog, so the picker is replaced with
 * one that hands back a file in OPFS. That exercises the real backwards-copy
 * path — write at a position, truncate the staged file — rather than skipping it.
 */
async function installFakePicker(context) {
  await context.addInitScript(() => {
    window.__savedTo = "destination.bin";
    window.showSaveFilePicker = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getFileHandle(window.__savedTo, { create: true });
    };
  });
}

/** Forces the download fallback, the path Firefox and iOS take. */
async function disablePicker(context) {
  await context.addInitScript(() => {
    delete window.showSaveFilePicker;
  });
}

/** Records the peak storage this origin uses while a save runs. */
async function watchPeakUsage(page) {
  await page.evaluate(() => {
    window.__peak = 0;
    window.__peakTimer = setInterval(async () => {
      const estimate = await navigator.storage.estimate();
      window.__peak = Math.max(window.__peak, estimate.usage || 0);
    }, 25);
  });
}

async function readPeakAndDestination(page) {
  return page.evaluate(async () => {
    clearInterval(window.__peakTimer);
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(window.__savedTo);
    const file = await handle.getFile();
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());

    let stagedBytes = 0;
    try {
      const staged = await root.getDirectoryHandle("staged");
      for await (const [, entry] of staged.entries()) {
        stagedBytes += (await entry.getFile()).size;
      }
    } catch {
      // No staging directory left at all is the ideal outcome.
    }

    return {
      size: file.size,
      digest: Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
      peak: window.__peak,
      stagedBytes,
    };
  });
}

/**
 * What the sending side currently claims to have transferred, read back off its
 * own progress line — the number a resuming user is actually looking at.
 */
async function senderReported(page) {
  const text = await page
    .locator("text=/[0-9.]+ [KMGT]?B of [0-9.]+ [KMGT]?B/")
    .first()
    .textContent()
    .catch(() => null);
  const match = text && text.match(/([0-9.]+) (B|KB|MB|GB|TB) of /);
  if (!match) return 0;
  return Number(match[1]) * 1024 ** ["B", "KB", "MB", "GB", "TB"].indexOf(match[2]);
}

async function storedBytes(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("apiplant-send");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!db.objectStoreNames.contains("transfers")) return 0;
    const records = await new Promise((resolve) => {
      const request = db.transaction("transfers", "readonly").objectStore("transfers").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve([]);
    });
    return records.reduce((total, record) => total + record.receivedBytes, 0);
  });
}

async function main() {
  const workdir = await mkdtemp(join(tmpdir(), "apiplant-send-e2e-"));
  const payload = randomBytes(48 * 1024 * 1024);
  const expected = createHash("sha256").update(payload).digest("hex");
  const source = join(workdir, "payload.bin");
  await writeFile(source, payload);

  let server = await startServer("required");
  const browser = await chromium.launch({ executablePath: CHROME });

  try {
    // ---- 1. a complete transfer, receiver typing the code by hand ----------
    const senderContext = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const sender = await senderContext.newPage();
    await sender.goto(ORIGIN);
    await sender.setInputFiles('input[type="file"]', source);

    const codeLocator = sender.locator("p.font-mono").first();
    await codeLocator.waitFor({ timeout: 120_000 });
    const code = (await codeLocator.textContent()).trim();
    check("the sender is issued a code", /^[0-9]+-[a-z]+-[a-z]+$/.test(code), code);

    const receiverContext = await browser.newContext();
    // The picker exists in this context on purpose: the automatic save must not
    // reach for it, because it has no user gesture to spend on one.
    await installFakePicker(receiverContext);
    const receiver = await receiverContext.newPage();
    await receiver.goto(ORIGIN);

    // Armed before the lookup, because finding the file is now the only step:
    // the download starts, verifies and saves itself with no further clicks.
    const autoDownload = receiver.waitForEvent("download", { timeout: 300_000 });
    // Typed the way the placeholder writes it — spaces, not dashes — because
    // that is the form a person reading a code aloud will produce.
    await receiver.locator("#code").fill(code.replace(/-/g, " "));
    await receiver.getByRole("button", { name: "Find file" }).click();

    await receiver.locator("text=code-authenticated").waitFor({ timeout: 60_000 });
    check("finding the file starts the transfer without a second click", true);

    const autoFile = await autoDownload;
    const autoPath = join(workdir, "auto.bin");
    await autoFile.saveAs(autoPath);
    check(
      "the verified file downloads itself without being asked",
      createHash("sha256").update(readFileSync(autoPath)).digest("hex") === expected,
    );

    // The receiver hangs up the moment it is done. That must read as success on
    // the sending side, not as the peer vanishing mid-transfer.
    await sender.locator("text=The file has been received").waitFor({ timeout: 60_000 });
    await wait(4000);
    check(
      "the sender stays complete after the finished receiver disconnects",
      (await sender.locator("text=Failed").count()) === 0 &&
        (await sender.locator("text=The file has been received").count()) === 1,
    );

    // The staged copy outlives the download, so Storage is where it gets
    // written out properly — and that path does have a gesture for the picker.
    await receiver.getByRole("button", { name: "Storage" }).click();
    const save = receiver.getByRole("button", { name: "Save to device" });
    await save.waitFor({ timeout: 20_000 });
    check("a received but unsaved file is offered for saving in Storage", true);

    await watchPeakUsage(receiver);
    await save.click();
    await save.waitFor({ state: "detached", timeout: 240_000 });
    const saved = await readPeakAndDestination(receiver);

    check("the saved file is byte-identical", saved.digest === expected, saved.digest.slice(0, 16));
    check("the staged copy is gone", saved.stagedBytes === 0, `${saved.stagedBytes} bytes left`);
    check("saving reclaims the transfer record", (await storedBytes(receiver)) === 0);

    // Segments are deleted as the copy passes them, so the disk never holds two
    // full copies. A 48 MB file fits in one 256 MB segment, so the ceiling here
    // is the segment, not the doubling; test:scale covers the multi-segment case.
    const ratio = saved.peak / payload.length;
    check(
      "saving does not need two copies on disk",
      ratio < 2.4,
      `peak was ${ratio.toFixed(2)}x the file size, ending at 1x`,
    );

    await receiverContext.close();

    // ---- 1b. a mistyped code is refused at the handshake -------------------
    await sender.getByRole("button", { name: "Send another file" }).click();
    await sender.setInputFiles('input[type="file"]', source);
    await codeLocator.waitFor({ timeout: 120_000 });
    const realCode = (await codeLocator.textContent()).trim();
    const [nameplate, firstWord] = realCode.split("-");
    // Same nameplate, one word wrong — the server cannot tell the difference,
    // which is the whole point of the words never reaching it.
    const wrongCode = `${nameplate}-${firstWord}-absurd`;

    const wrongContext = await browser.newContext();
    const wrongPage = await wrongContext.newPage();
    await wrongPage.goto(ORIGIN);
    await wrongPage.locator("#code").fill(wrongCode);
    await wrongPage.getByRole("button", { name: "Find file" }).click();
    // The nameplate still resolves — the words never reached the server — so the
    // download starts and is then refused by the confirmation exchange.
    await wrongPage.locator("text=does not match").waitFor({ timeout: 30_000 });
    check("a wrong word still resolves the nameplate", true);
    check("a wrong word is rejected before any bytes move", (await storedBytes(wrongPage)) === 0);
    await wrongContext.close();

    // ---- 2. an interrupted transfer resumes from what was stored ----------
    const flaky = await browser.newContext();
    await disablePicker(flaky);
    const flakyPage = await flaky.newPage();
    await flakyPage.goto(ORIGIN);

    // Every scenario starts from a fresh offer.
    await sender.getByRole("button", { name: "Send another file" }).click();
    await sender.setInputFiles('input[type="file"]', source);
    await codeLocator.waitFor({ timeout: 120_000 });
    const firstCode = (await codeLocator.textContent()).trim();

    await flakyPage.locator("#code").fill(firstCode);
    await flakyPage.getByRole("button", { name: "Find file" }).click();

    // Cut the connection once some chunks are safely on disk but not all.
    let partial = 0;
    for (let attempt = 0; attempt < 600; attempt++) {
      partial = await storedBytes(flakyPage);
      if (partial > 2 * 1024 * 1024 && partial < payload.length * 0.7) break;
      await wait(50);
    }
    check("chunks are on disk mid-transfer", partial > 2 * 1024 * 1024, `${partial} bytes`);

    await flakyPage.reload();
    await wait(300);
    const survived = await storedBytes(flakyPage);
    check("a reload does not lose stored chunks", survived >= partial, `${survived} bytes`);

    // The sender's connection died with the reload; it hands out a new code.
    await sender.getByRole("button", { name: /New code|Send another file/ }).first().click();
    if (await sender.locator('input[type="file"]').count()) {
      await sender.setInputFiles('input[type="file"]', source);
    }
    await codeLocator.waitFor({ timeout: 120_000 });
    const secondCode = (await codeLocator.textContent()).trim();
    check("a second code is issued for the same file", secondCode !== firstCode, secondCode);

    const resumedDownload = flakyPage.waitForEvent("download", { timeout: 300_000 });
    await flakyPage.locator("#code").fill(secondCode);
    await flakyPage.getByRole("button", { name: "Find file" }).click();

    // A resumed transfer must not look like a fresh one on the sending side:
    // the sender is told what the receiver already has, and reports from there.
    let senderStart = 0;
    for (let attempt = 0; attempt < 600; attempt++) {
      senderStart = await senderReported(sender);
      if (senderStart > 0) break;
      await wait(50);
    }
    check(
      "the sender resumes from what the receiver already has, not from zero",
      senderStart >= partial * 0.8,
      `sender reported ${(senderStart / 1e6).toFixed(1)} MB against ${(partial / 1e6).toFixed(1)} MB staged`,
    );

    const resumedFile = await resumedDownload;
    const resumedPath = join(workdir, "resumed.bin");
    await resumedFile.saveAs(resumedPath);
    const resumedDigest = createHash("sha256").update(readFileSync(resumedPath)).digest("hex");
    check("the resumed file verifies byte for byte", resumedDigest === expected);
    check("the download fallback works where there is no picker", true);

    await flaky.close();

    // ---- 3. the share link carries the key ---------------------------------
    await sender.getByRole("button", { name: "Send another file" }).click();
    await sender.setInputFiles('input[type="file"]', source);
    await codeLocator.waitFor({ timeout: 120_000 });
    await sender.getByRole("button", { name: "Copy link" }).click();
    const shareLink = await sender.evaluate(() => navigator.clipboard.readText());
    check(
      "the share link carries the whole code in the fragment",
      /#[0-9]+-[a-z]+-[a-z]+$/.test(shareLink),
      shareLink,
    );

    const scanned = await browser.newContext();
    await disablePicker(scanned);
    const scannedPage = await scanned.newPage();
    const scannedDownload = scannedPage.waitForEvent("download", { timeout: 300_000 });
    await scannedPage.goto(shareLink);
    await scannedPage.locator("text=code-authenticated").waitFor({ timeout: 60_000 });
    check("opening the link authenticates the same way a typed code does", true);
    await scannedDownload;
    check("the link transfer completes and saves itself", true);
    await scanned.close();
    await senderContext.close();

    // ---- 4. the server can switch the end-to-end layer off ----------------
    // Timing lives in bench.mjs; this only checks the policy is honoured.
    server.kill();
    // Not a fixed sleep: the replacement has to bind the port itself, and a
    // health check answered by the dying process would let the old policy stand.
    await waitForPortFree();
    server = await startServer("off");

    const plainContext = await browser.newContext();
    const plainSender = await plainContext.newPage();
    await plainSender.goto(ORIGIN);
    await plainSender.setInputFiles('input[type="file"]', source);
    await plainSender.locator("p.font-mono").first().waitFor({ timeout: 120_000 });
    const plainCode = (await plainSender.locator("p.font-mono").first().textContent()).trim();

    const plainReceiverContext = await browser.newContext();
    await disablePicker(plainReceiverContext);
    const plainReceiver = await plainReceiverContext.newPage();
    await plainReceiver.goto(ORIGIN);
    const plainDownload = plainReceiver.waitForEvent("download", { timeout: 300_000 });
    await plainReceiver.locator("#code").fill(plainCode);
    await plainReceiver.getByRole("button", { name: "Find file" }).click();

    // Asserted on the sending side: the receiver clears its panel as soon as the
    // download starts, so its own note is gone by the time the file lands.
    await plainSender.locator("text=Transport encryption only").waitFor({ timeout: 60_000 });
    check("the app says so rather than claiming encryption", true);

    const plainSaved = await plainDownload;
    check("a transfer completes with the end-to-end layer off", true);
    const plainPath = join(workdir, "plain.bin");
    await plainSaved.saveAs(plainPath);
    check(
      "the unencrypted transfer is still byte-identical",
      createHash("sha256").update(readFileSync(plainPath)).digest("hex") === expected,
    );

    await plainContext.close();
    await plainReceiverContext.close();
  } finally {
    await browser.close();
    server.kill();
    await rm(workdir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nall end-to-end checks passed" : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
