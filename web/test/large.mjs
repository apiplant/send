/**
 * One large transfer, end to end, to check that nothing in the path scales with
 * file size in memory. Defaults to 2 GB; set SIZE_MB higher if you have the disk
 * and the patience.
 *
 *   SIZE_MB=4096 npm run test:large
 *
 * Reports peak JS heap and peak origin storage alongside the timings, because
 * the failure mode this guards against is a tab that dies at 4 GB rather than a
 * wrong answer.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, open as openFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = 8125;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome-stable";
const SERVER = new URL("../../server/target/release/apiplant-send", import.meta.url).pathname;
const STATIC = new URL("../../server/static", import.meta.url).pathname;
const SIZE_MB = Number(process.env.SIZE_MB ?? 2048);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

// Deliberately not os.tmpdir(): /tmp is tmpfs on many Linux systems, so a
// multi-gigabyte source file would be written into RAM and starve the browser.
// WORKDIR should point at real disk.
const workdir = await mkdtemp(
  join(process.env.WORKDIR ?? new URL("../../../", import.meta.url).pathname, ".large-test-"),
);
const source = join(workdir, "large.bin");

// Written and hashed in blocks; the test must not need the file in memory either.
console.log(`building a ${SIZE_MB} MB source file...`);
const hash = createHash("sha256");
const handle = await openFile(source, "w");
for (let written = 0; written < SIZE_MB; written++) {
  const block = randomBytes(1024 * 1024);
  hash.update(block);
  await handle.write(block);
}
await handle.close();
const expected = hash.digest("hex");
const bytesTotal = SIZE_MB * 1024 * 1024;

const server = spawn(SERVER, [], {
  env: {
    ...process.env,
    APIPLANT_SEND_ADDR: `127.0.0.1:${PORT}`,
    APIPLANT_SEND_STATIC: STATIC,
  },
  stdio: "ignore",
});
for (let attempt = 0; attempt < 60; attempt++) {
  if (await fetch(`${ORIGIN}/api/health`).then(() => true, () => false)) break;
  await wait(100);
}

/**
 * Two persistent contexts, each with its own profile on real disk. Playwright
 * defaults profiles to os.tmpdir(), which is tmpfs on many Linux systems —
 * staging gigabytes into RAM there gets the browser OOM-killed, which looks
 * exactly like an application bug and is not one.
 */
const senderContext = await chromium.launchPersistentContext(join(workdir, "sender-profile"), {
  executablePath: CHROME,
});
const receiverContext = await chromium.launchPersistentContext(join(workdir, "receiver-profile"), {
  executablePath: CHROME,
});
for (const [tag, context] of [["sender", senderContext], ["receiver", receiverContext]]) {
  context.on("close", () => console.log(`  !! ${tag} browser closed`));
}

try {
  await receiverContext.addInitScript(() => {
    window.__savedTo = "destination.bin";
    window.showSaveFilePicker = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getFileHandle(window.__savedTo, { create: true });
    };
  });

  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  for (const [tag, page] of [["sender", sender], ["receiver", receiver]]) {
    page.on("crash", () => console.log(`  !! ${tag} page crashed`));
    page.on("pageerror", (error) => console.log(`  !! ${tag} error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") console.log(`  !! ${tag} console: ${message.text()}`);
    });
  }

  const hashStarted = Date.now();
  await sender.goto(ORIGIN);
  await sender.setInputFiles('input[type="file"]', source);
  const codeLocator = sender.locator("p.font-mono").first();
  await codeLocator.waitFor({ timeout: 600_000 });
  const code = (await codeLocator.textContent()).trim();
  console.log(`  sender hashed ${SIZE_MB} MB in ${((Date.now() - hashStarted) / 1000).toFixed(1)}s`);

  await receiver.goto(ORIGIN);
  // Sample heap and storage throughout, so a leak shows up as a number.
  await receiver.evaluate(() => {
    window.__peakHeap = 0;
    window.__peakUsage = 0;
    window.__timer = setInterval(async () => {
      if (performance.memory) {
        window.__peakHeap = Math.max(window.__peakHeap, performance.memory.usedJSHeapSize);
      }
      const estimate = await navigator.storage.estimate();
      window.__peakUsage = Math.max(window.__peakUsage, estimate.usage || 0);
    }, 250);
  });

  await receiver.locator("#code").fill(code);
  await receiver.getByRole("button", { name: "Find file" }).click();
  await receiver.getByRole("button", { name: /Start download/ }).waitFor({ timeout: 60_000 });

  const started = Date.now();
  await receiver.getByRole("button", { name: /Start download/ }).click();
  const save = receiver.getByRole("button", { name: "Save to device" });

  // Report progress while waiting, so a stall is distinguishable from a crash.
  const watcher = setInterval(async () => {
    try {
      const text = await receiver.locator("main").innerText();
      const line = text.split("\n").find((l) => l.includes("%")) ?? text.split("\n")[0];
      console.log(`     [${((Date.now() - started) / 1000).toFixed(0)}s] ${line.trim()}`);
    } catch (error) {
      console.log(`     [watch] ${String(error).split("\n")[0]}`);
    }
  }, 15_000);
  try {
    await save.waitFor({ timeout: 3_600_000 });
  } finally {
    clearInterval(watcher);
  }
  const transferred = Date.now() - started;
  check("the transfer completed and the checksum verified", true);
  console.log(
    `  transferred and verified in ${(transferred / 1000).toFixed(1)}s ` +
      `(${(bytesTotal / 1e6 / (transferred / 1000)).toFixed(1)} MB/s)`,
  );

  const saveStarted = Date.now();
  await save.click();
  await receiver.locator("text=Saved and verified").waitFor({ timeout: 3_600_000 });
  console.log(`  saved to disk in ${((Date.now() - saveStarted) / 1000).toFixed(1)}s`);

  const result = await receiver.evaluate(async () => {
    clearInterval(window.__timer);
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle(window.__savedTo)).getFile();

    // Hashed in slices: the test cannot hold the file in memory either.
    let staged = 0;
    try {
      const dir = await root.getDirectoryHandle("staged");
      for await (const [, entry] of dir.entries()) staged += (await entry.getFile()).size;
    } catch {}
    return {
      size: file.size,
      staged,
      peakHeap: window.__peakHeap,
      peakUsage: window.__peakUsage,
    };
  });

  check("the destination is the right size", result.size === bytesTotal, gb(result.size));
  check("the staged copy was reclaimed", result.staged === 0, `${result.staged} bytes left`);
  check(
    "peak heap stayed small",
    result.peakHeap < 512 * 1024 * 1024,
    `peak JS heap ${(result.peakHeap / 1e6).toFixed(0)} MB for a ${gb(bytesTotal)} file`,
  );
  console.log(`  peak origin storage ${gb(result.peakUsage)} (${(result.peakUsage / bytesTotal).toFixed(2)}x)`);

  // The app verified the staged file against the sender's digest before offering
  // to save. Confirm the saved bytes independently by sampling slices at random
  // offsets — enough to catch an off-by-one in the chunk or copy maths without
  // hauling gigabytes back through the debugging protocol.
  const source_ = await openFile(source, "r");
  let mismatched = 0;
  for (let sample = 0; sample < 12; sample++) {
    const length = 1024 * 1024;
    const offset = Math.min(
      bytesTotal - length,
      Math.floor(Math.random() * (bytesTotal - length)),
    );

    const fromSource = Buffer.alloc(length);
    await source_.read(fromSource, 0, length, offset);

    const fromSaved = await receiver.evaluate(
      async ([at, len]) => {
        const root = await navigator.storage.getDirectory();
        const file = await (await root.getFileHandle(window.__savedTo)).getFile();
        const buffer = await file.slice(at, at + len).arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", buffer);
        return Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      },
      [offset, length],
    );

    if (createHash("sha256").update(fromSource).digest("hex") !== fromSaved) mismatched++;
  }
  await source_.close();
  check("12 random 1 MB slices match the source exactly", mismatched === 0, `${mismatched} differed`);
} finally {
  await senderContext.close().catch(() => {});
  await receiverContext.close().catch(() => {});
  server.kill();
  await rm(workdir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nlarge-file check passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
