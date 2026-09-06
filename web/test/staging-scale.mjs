/**
 * Proves the receive path does not scale with file size in memory, without
 * needing two browser renderers and a real WebRTC transfer (which a busy machine
 * cannot afford at multi-gigabyte sizes).
 *
 * It drives the real staging module: writes a large file into OPFS chunk by
 * chunk exactly as the receiver does, verifies it with the same streaming hash,
 * and samples the JS heap throughout. Runs against the Vite dev server so the
 * TypeScript modules can be imported directly.
 *
 *   SIZE_MB=4096 npm run test:scale
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const ORIGIN = "http://127.0.0.1:3100";
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome-stable";
const SIZE_MB = Number(process.env.SIZE_MB ?? 3072);
const CHUNK_MB = 1;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

/** Block `i` is filled with byte `i % 251`, so Node can predict the digest. */
function expectedDigest() {
  const hash = createHash("sha256");
  for (let i = 0; i < SIZE_MB / CHUNK_MB; i++) {
    hash.update(Buffer.alloc(CHUNK_MB * 1024 * 1024, i % 251));
  }
  return hash.digest("hex");
}

const vite = spawn("npx", ["vite", "--port", "3100", "--host", "127.0.0.1"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "ignore",
});
for (let attempt = 0; attempt < 100; attempt++) {
  if (await fetch(ORIGIN).then(() => true, () => false)) break;
  await wait(200);
}

// The browser profile — and so all of OPFS — must live on real disk. Playwright
// defaults it to os.tmpdir(), which is tmpfs on many Linux systems, and staging
// several gigabytes into RAM gets the browser OOM-killed.
const profile = await mkdtemp(
  join(process.env.WORKDIR ?? new URL("../../../", import.meta.url).pathname, ".large-test-"),
);
const browser = await chromium.launchPersistentContext(profile, { executablePath: CHROME });
const page = await browser.newPage();
page.on("crash", () => console.log("  !! page crashed"));
page.on("pageerror", (error) => console.log("  !! error:", error.message));

try {
  await page.goto(ORIGIN);
  const expected = expectedDigest();
  console.log(`writing ${SIZE_MB} MB into OPFS through the real staging module...`);

  const result = await page.evaluate(
    async ([sizeMb, chunkMb]) => {
      const { staging } = await import("/src/lib/staging.ts");
      const id = "scale-test";
      await staging.remove(id).catch(() => {});

      const chunkBytes = chunkMb * 1024 * 1024;
      const chunks = sizeMb / chunkMb;
      let peakHeap = 0;
      const sample = () => {
        if (performance.memory) {
          peakHeap = Math.max(peakHeap, performance.memory.usedJSHeapSize);
        }
      };

      const writeStarted = performance.now();
      for (let i = 0; i < chunks; i++) {
        // A fresh buffer each time, exactly as the receiver assembles one.
        const block = new Uint8Array(new ArrayBuffer(chunkBytes)).fill(i % 251);
        await staging.write(id, i * chunkBytes, block);
        if (i % 16 === 0) sample();
      }
      const writeMs = performance.now() - writeStarted;

      const hashStarted = performance.now();
      let lastProgress = 0;
      const digest = await staging.hash(id, sizeMb * 1024 * 1024, (fraction) => {
        lastProgress = fraction;
        sample();
      });
      const hashMs = performance.now() - hashStarted;

      const staged = await staging.size(id);
      await staging.remove(id);
      const afterRemoval = (await navigator.storage.estimate()).usage || 0;

      return { digest, staged, writeMs, hashMs, peakHeap, lastProgress, afterRemoval };
    },
    [SIZE_MB, CHUNK_MB],
  );

  const totalBytes = SIZE_MB * 1024 * 1024;
  check("the staged file is exactly the right size", result.staged === totalBytes, `${result.staged}`);
  check("the streaming hash matches", result.digest === expected, result.digest.slice(0, 16));
  check("hashing reported completion", result.lastProgress === 1);
  check(
    "peak heap is independent of file size",
    result.peakHeap < 256 * 1024 * 1024,
    `${(result.peakHeap / 1e6).toFixed(0)} MB peak for a ${(SIZE_MB / 1024).toFixed(1)} GB file`,
  );
  check(
    "removing the staged file reclaims the space",
    result.afterRemoval < 256 * 1024 * 1024,
    `${(result.afterRemoval / 1e6).toFixed(0)} MB still in use`,
  );

  console.log(
    `  wrote at ${(totalBytes / 1e6 / (result.writeMs / 1000)).toFixed(0)} MB/s, ` +
      `hashed at ${(totalBytes / 1e6 / (result.hashMs / 1000)).toFixed(0)} MB/s`,
  );
} finally {
  await browser.close();
  vite.kill();
  await rm(profile, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nstaging scale check passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
