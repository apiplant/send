/**
 * Measures what the end-to-end encryption layer actually costs, because a single
 * timed transfer over loopback turned out to vary by more than the effect being
 * measured.
 *
 * Two numbers, because they answer different questions:
 *   1. a microbenchmark of AES-GCM at the real frame size, in the real browser —
 *      the ceiling on how much crypto alone can cost;
 *   2. alternating end-to-end transfers, reported as medians — what a user sees.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = 8124;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome-stable";
const SERVER = new URL("../../server/target/release/apiplant-send", import.meta.url).pathname;
const STATIC = new URL("../../server/static", import.meta.url).pathname;
const TRIALS = Number(process.env.TRIALS ?? 5);
const SIZE_MB = Number(process.env.SIZE_MB ?? 48);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function startServer(encryption) {
  const child = spawn(SERVER, [], {
    env: {
      ...process.env,
      APIPLANT_SEND_ADDR: `127.0.0.1:${PORT}`,
      APIPLANT_SEND_STATIC: STATIC,
      APIPLANT_SEND_ENCRYPTION: encryption,
    },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(`${ORIGIN}/api/health`).then(() => true, () => false)) return child;
    await wait(100);
  }
  throw new Error("the signalling server did not come up");
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

/** One transfer, timed from the click to the last chunk hitting disk. */
async function timeTransfer(browser, source, bytes) {
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();

  await sender.goto(ORIGIN);
  await sender.setInputFiles('input[type="file"]', source);
  const codeLocator = sender.locator("p.font-mono").first();
  await codeLocator.waitFor({ timeout: 120_000 });
  const code = (await codeLocator.textContent()).trim();

  await receiver.goto(ORIGIN);
  await receiver.locator("#code").fill(code);
  await receiver.getByRole("button", { name: "Find file" }).click();
  await receiver.getByRole("button", { name: /Start download/ }).click();

  const started = Date.now();
  let stored = 0;
  while (stored < bytes && Date.now() - started < 300_000) stored = await storedBytes(receiver);
  const elapsed = Date.now() - started;

  await senderContext.close();
  await receiverContext.close();
  return elapsed;
}

/** AES-GCM alone, at the frame size the transfer actually negotiates. */
async function microbenchmark(page, totalBytes) {
  return page.evaluate(async (total) => {
    const FRAME = 64 * 1024;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const plaintext = crypto.getRandomValues(new Uint8Array(FRAME));
    const header = new Uint8Array(8);
    const iv = new Uint8Array(12);
    const frames = Math.ceil(total / FRAME);

    const started = performance.now();
    for (let i = 0; i < frames; i++) {
      new DataView(iv.buffer).setUint32(4, i, false);
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: header },
        key,
        plaintext,
      );
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: header },
        key,
        sealed,
      );
    }
    return performance.now() - started;
  }, totalBytes);
}

const workdir = await mkdtemp(join(tmpdir(), "apiplant-send-bench-"));
const payload = randomBytes(SIZE_MB * 1024 * 1024);
const source = join(workdir, "payload.bin");
await writeFile(source, payload);

let server = await startServer("required");
const browser = await chromium.launch({ executablePath: CHROME });

try {
  const page = await browser.newPage();
  await page.goto(ORIGIN);
  const cryptoMs = await microbenchmark(page, payload.length);
  console.log(
    `AES-256-GCM alone, ${SIZE_MB} MB in 64 KiB frames (seal + open, in-browser):\n` +
      `  ${cryptoMs.toFixed(0)} ms — ${(SIZE_MB / (cryptoMs / 1000)).toFixed(0)} MB/s\n`,
  );
  await page.close();

  const encrypted = [];
  const plaintext = [];
  for (let trial = 0; trial < TRIALS; trial++) {
    encrypted.push(await timeTransfer(browser, source, payload.length));
    server.kill();
    await wait(200);
    server = await startServer("off");

    plaintext.push(await timeTransfer(browser, source, payload.length));
    server.kill();
    await wait(200);
    server = await startServer("required");

    process.stdout.write(
      `  trial ${trial + 1}: encrypted ${encrypted.at(-1)} ms, plaintext ${plaintext.at(-1)} ms\n`,
    );
  }

  const encryptedMedian = median(encrypted);
  const plaintextMedian = median(plaintext);
  const overhead = ((encryptedMedian - plaintextMedian) / plaintextMedian) * 100;
  const rate = (ms) => (SIZE_MB / (ms / 1000)).toFixed(1);

  console.log(
    `\n${SIZE_MB} MB over loopback, median of ${TRIALS}:\n` +
      `  encrypted  ${encryptedMedian} ms  (${rate(encryptedMedian)} MB/s)  range ${Math.min(...encrypted)}–${Math.max(...encrypted)}\n` +
      `  plaintext  ${plaintextMedian} ms  (${rate(plaintextMedian)} MB/s)  range ${Math.min(...plaintext)}–${Math.max(...plaintext)}\n` +
      `  overhead   ${overhead >= 0 ? "+" : ""}${overhead.toFixed(1)}%`,
  );
} finally {
  await browser.close();
  server.kill();
  await rm(workdir, { recursive: true, force: true });
}
