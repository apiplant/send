import { createSignal, onCleanup, Show } from "solid-js";
import { deleteSession, getSession, type EncryptionPolicy, type FileMeta } from "../lib/api";
import { bytes, percent } from "../lib/format";
import { parseCode } from "../lib/words";
import { getTransfer, newRecord, putTransfer, type TransferRecord } from "../lib/idb";
import { pickDestination, saveByDownload, saveToPickedFile } from "../lib/save";
import {
  checkQuota,
  discardTransfer,
  requestPersistence,
  savePickerSupported,
  stagingSupported,
} from "../lib/staging";
import {
  runReceiver,
  verifyStaged,
  type Phase,
  type SecurityInfo,
  type TransferHandle,
} from "../lib/transfer";
import { Icon, icons, PhasePill, ProgressBar, SecurityNote, TransferStats } from "./ui";

export default function ReceiveTab(props: {
  policy: EncryptionPolicy;
  initialCode?: string;
  onStorageChanged?: () => void;
}) {
  const [code, setCode] = createSignal(props.initialCode ?? "");
  // Split once the code parses; the words never leave the browser.
  const [parsed, setParsed] = createSignal<{ nameplate: string; words: string }>();
  const [meta, setMeta] = createSignal<FileMeta>();
  const [record, setRecord] = createSignal<TransferRecord>();
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [detail, setDetail] = createSignal<string>();
  // Kept apart from `detail` so a success line never renders in the error slot.
  const [notice, setNotice] = createSignal<string>();
  const [security, setSecurity] = createSignal<SecurityInfo>();
  const [progress, setProgress] = createSignal({ bytes: 0, total: 0, bytesPerSecond: 0 });
  const [looking, setLooking] = createSignal(false);
  const [verifyProgress, setVerifyProgress] = createSignal(0);
  const [verified, setVerified] = createSignal(false);
  const [checksumFailed, setChecksumFailed] = createSignal(false);
  const [saveProgress, setSaveProgress] = createSignal<number>();
  const [tooBig, setTooBig] = createSignal<string>();

  let handle: TransferHandle | undefined;
  onCleanup(() => handle?.cancel());

  /**
   * Looks the code up and reports how much of this file is already on disk.
   * A code the user typed here starts downloading straight away; one that
   * arrived in a share link stops at the "Start download" button.
   */
  const lookup = async (autoStart = true) => {
    // Private modes and a few older builds have no OPFS; without it there is
    // nowhere to stage a partial download, so say that rather than fail later.
    if (!stagingSupported()) {
      setDetail(
        "This browser has no file storage available. Try a normal window.",
      );
      setPhase("failed");
      return;
    }

    const parts = parseCode(code());
    if (!parts) {
      setMeta(undefined);
      setDetail("Invalid code. Format: 4 unicorn waffle.");
      setPhase("failed");
      return;
    }

    setLooking(true);
    setDetail(undefined);
    setNotice(undefined);
    setChecksumFailed(false);
    setVerified(false);
    setTooBig(undefined);
    try {
      // Only the nameplate is sent; the server has no use for the words.
      const session = await getSession(parts.nameplate);

      // A code is good for one download. If someone else has already started on
      // it, stop here — don't open a peer connection that would fight the first
      // receiver over the same signalling mailbox.
      if (session.claimed) {
        setMeta(undefined);
        setDetail(
          "This code has already been used to download the file. Ask the sender for a new one.",
        );
        setPhase("failed");
        return;
      }

      setParsed(parts);
      setMeta(session.meta);

      // A record keyed by the file's digest is what makes resuming work across
      // codes, tabs and days: same file, same bucket of chunks.
      const existing = await getTransfer(session.meta.sha256);
      const current = existing ?? newRecord(session.meta);
      if (!existing) await putTransfer(current);
      setRecord(current);
      setProgress({ bytes: current.receivedBytes, total: current.size, bytesPerSecond: 0 });
      setPhase("idle");
      props.onStorageChanged?.();

      // Refuse a file that cannot possibly fit before a byte moves, rather than
      // failing at 90% with a quota error.
      const outstanding = current.size - current.receivedBytes;
      const room = await checkQuota(outstanding);
      if (room && !room.fits) {
        setTooBig(
          `Needs ${bytes(outstanding)} more, but only ${bytes(room.available)} is available. ` +
            `Free up space or clear partial downloads in the Storage tab.`,
        );
      }
      // Asking marks the data as worth keeping, so the browser is less likely to
      // evict a half-finished 10 GB transfer under pressure.
      void requestPersistence();

      if (autoStart && (!room || room.fits)) {
        start({ record: current, meta: session.meta, parsed: parts });
      }
    } catch (error) {
      setMeta(undefined);
      setDetail(error instanceof Error ? error.message : String(error));
      setPhase("failed");
    } finally {
      setLooking(false);
    }
  };

  /**
   * Arguments rather than signal reads: a `set` is not visible to a `get` in the
   * same synchronous scope, so the automatic start right after a lookup has to
   * be handed the record and metadata it was given.
   */
  const start = (from?: { record: TransferRecord; meta: FileMeta; parsed: { nameplate: string; words: string } }) => {
    const current = from?.record ?? record();
    const info = from?.meta ?? meta();
    const parts = from?.parsed ?? parsed();
    if (!current || !info || !parts) return;

    setChecksumFailed(false);
    handle = runReceiver({
      nameplate: parts.nameplate,
      words: parts.words,
      meta: info,
      record: current,
      policy: props.policy,
      events: {
        onPhase: (next, why) => {
          setPhase(next);
          setDetail(why);
        },
        onSecurity: setSecurity,
        onProgress: (update) => setProgress(update),
        onError: (error) => setDetail(error.message),
        onComplete: (finished) => {
          if (finished) setRecord(finished);
          props.onStorageChanged?.();
          void verify(finished ?? current, info);
        },
      },
    });
  };

  /** Streams the staged file through SHA-256 and compares with the sender's. */
  const verify = async (current: TransferRecord, info: FileMeta) => {
    setPhase("verifying");
    setVerifyProgress(0);
    try {
      const result = await verifyStaged(current, info.sha256, setVerifyProgress);
      if (!result.ok) {
        setChecksumFailed(true);
        setPhase("failed");
        setDetail("Checksum mismatch — the file is corrupted.");
        return;
      }
      setVerified(true);
      setPhase("complete");
      const parts = parsed();
      if (parts) void deleteSession(parts.nameplate);
      // Straight to the download. The save picker needs a user gesture and there
      // is none here, so this takes the browser's own downloader — which is what
      // asks the user where to put the file. The staged copy stays behind, and
      // the Storage tab can write it out again if the download went wrong.
      //
      // `current` is handed over rather than read back from the signal: a write
      // is not visible to a read in the same synchronous scope, so `verified()`
      // here would still be false.
      await save({ auto: true, record: current });
    } catch (error) {
      setPhase("failed");
      setDetail(error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * Writes the verified file out to the device. Where the browser has a save
   * picker this copies backwards and truncates as it goes, so the disk never
   * holds two full copies; elsewhere it falls back to an ordinary download.
   *
   * `pickDestination` runs before any await because the picker needs the click.
   */
  const save = async (options?: { auto?: boolean; record?: TransferRecord }) => {
    const current = options?.record ?? record();
    // A verified file is the only thing worth writing out, and only the button
    // has to check that — the automatic path is called from the verify itself.
    if (!current || (!options?.auto && !verified())) return;

    try {
      // An automatic save has no user activation behind it, so the picker would
      // throw; the downloader is the only route that works unprompted.
      const destination = options?.auto ? null : await pickDestination(current);
      if (!options?.auto && savePickerSupported() && !destination) return; // cancelled

      if (destination) {
        setSaveProgress(0);
        const result = await saveToPickedFile(current, destination, setSaveProgress);
        setNotice(
          result.reclaimed
            ? "Saved and verified. Local copy reclaimed."
            : "Saved and verified.",
        );
        await discardTransfer(current.id);
      } else {
        await saveByDownload(current);
        await discardTransfer(current.id);
        setNotice("Downloaded and verified. Local copy reclaimed.");
      }

      setSaveProgress(undefined);
      setVerified(false);
      setRecord(undefined);
      setMeta(undefined);
      setPhase("idle");
      props.onStorageChanged?.();
    } catch (error) {
      setSaveProgress(undefined);
      setPhase("failed");
      setDetail(
        `Save interrupted: ${error instanceof Error ? error.message : String(error)}. ` +
          "Progress is kept — ask the sender for a new code to resume.",
      );
      // Segments already copied out were deleted and cleared from the bitmap, so
      // a resume now asks only for the part that went missing.
      const refreshed = await getTransfer(current.id);
      if (refreshed) setRecord(refreshed);
      props.onStorageChanged?.();
    }
  };

  /** A checksum mismatch means the staged bytes are unusable; start clean. */
  const discardAndRetry = async () => {
    const current = record();
    if (current) await discardTransfer(current.id);
    props.onStorageChanged?.();
    setRecord(undefined);
    setChecksumFailed(false);
    setVerified(false);
    await lookup();
  };

  /** Clears everything and returns to the bare code-entry screen. */
  const reset = () => {
    handle?.cancel();
    handle = undefined;
    setParsed(undefined);
    setMeta(undefined);
    setRecord(undefined);
    setPhase("idle");
    setDetail(undefined);
    setNotice(undefined);
    setSecurity(undefined);
    setProgress({ bytes: 0, total: 0, bytesPerSecond: 0 });
    setVerifyProgress(0);
    setVerified(false);
    setChecksumFailed(false);
    setSaveProgress(undefined);
    setTooBig(undefined);
    setCode("");
  };

  // A code arriving from a share link is looked up without another click.
  if (props.initialCode) void lookup(false);

  const resuming = () => (record()?.receivedBytes ?? 0) > 0;

  // While the transfer is running there is nothing to do on the code field, and
  // on a phone it just pushes the real progress off-screen — so hide it.
  const busy = () =>
    phase() === "connecting" ||
    phase() === "transferring" ||
    phase() === "verifying" ||
    saveProgress() !== undefined;

  return (
    <div class="space-y-5">
      <Show when={!busy()}>
      <div class="card space-y-4 p-6">
        <div>
          <label for="code" class="text-xs font-medium tracking-wide text-faint uppercase">
            Transfer code
          </label>
          <p class="mt-1 text-sm text-faint">
            Enter the code from the sending device.
          </p>
        </div>
        <div class="flex flex-col gap-2 sm:flex-row">
          <input
            id="code"
            class="field font-mono"
            placeholder="4 unicorn waffle"
            autocomplete="off"
            spellcheck={false}
            value={code()}
            onInput={(event) => setCode(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && void lookup()}
          />
          <button class="btn-primary sm:w-40" disabled={!code().trim() || looking()} onClick={() => void lookup()}>
            {looking() ? "Looking up…" : "Find file"}
          </button>
        </div>
        <Show when={!meta() && detail()}>
          <p class="text-sm text-danger">{detail()}</p>
        </Show>

      </div>
      </Show>

      <Show when={meta()}>
        {(info) => (
          <div class="card overflow-hidden">
            <div class="flex items-start gap-4 p-6">
              <div class="rounded-xl border border-line bg-surface-2 p-3">
                <Icon path={icons.file} class="size-6 text-muted" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate font-medium text-ink" title={info().name}>
                  {info().name}
                </p>
                <p class="text-sm text-faint">
                  {bytes(info().size)}
                  <Show when={info().mime}>
                    <span class="mx-2 text-faint">·</span>
                    {info().mime}
                  </Show>
                </p>
                <Show when={resuming() && phase() === "idle"}>
                  <p class="mt-2 text-sm text-info">
                    {bytes(record()!.receivedBytes)} already downloaded — will resume.
                  </p>
                </Show>
              </div>
            </div>

            <div class="space-y-4 border-t border-line bg-inset px-6 py-5">
              <PhasePill phase={phase()} detail={phase() === "failed" ? detail() : undefined} />

              <Show when={phase() === "verifying"}>
                <ProgressBar fraction={verifyProgress()} active tone="sky" />
              </Show>

              <Show when={phase() !== "verifying" && (progress().bytes > 0 || phase() === "transferring")}>
                <TransferStats
                  received={progress().bytes}
                  total={progress().total || info().size}
                  bytesPerSecond={progress().bytesPerSecond}
                  active={phase() === "transferring"}
                />
              </Show>

              <Show when={security()}>{(info) => <SecurityNote info={info()} />}</Show>

              <Show when={verified()}>
                <div class="rounded-xl border border-accent/25 bg-accent/[0.07] px-4 py-3 text-sm text-accent">
                  <div class="flex items-center gap-2 font-medium">
                    <Icon path={icons.check} class="size-4" />
                    Checksum verified
                  </div>
                  <p class="mt-1 text-muted">Choose where to put it.</p>
                </div>
              </Show>

              <Show when={saveProgress() !== undefined}>
                <div class="space-y-2">
                  <ProgressBar fraction={saveProgress()!} active />
                  <p class="text-xs text-faint">Writing to device — {percent(saveProgress()!)}.</p>
                </div>
              </Show>

              <Show when={tooBig()}>
                <p class="rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-xs text-warn">
                  {tooBig()}
                </p>
              </Show>

              <div class="flex flex-wrap gap-2">
                <Show when={verified()}>
                  <button
                    class="btn-primary"
                    disabled={saveProgress() !== undefined}
                    onClick={() => void save()}
                  >
                    <Icon path={icons.download} class="size-4" />
                    Save to device
                  </button>
                </Show>
                <Show
                  when={
                    !verified() &&
                    saveProgress() === undefined &&
                    phase() !== "transferring" &&
                    phase() !== "verifying" &&
                    phase() !== "connecting"
                  }
                >
                  <button
                    class="btn-primary w-full justify-center py-3 text-base sm:w-auto"
                    onClick={() => start()}
                  >
                    <Icon path={icons.download} class="size-5" />
                    {resuming() ? "Resume download" : "Start download"}
                  </button>
                </Show>
                <Show when={phase() === "transferring" || phase() === "connecting"}>
                  <button
                    class="btn-ghost"
                    onClick={() => {
                      handle?.cancel();
                      handle = undefined;
                    }}
                  >
                    Stop
                  </button>
                </Show>
                <Show when={checksumFailed()}>
                  <button class="btn-danger" onClick={() => void discardAndRetry()}>
                    <Icon path={icons.trash} class="size-4" />
                    Discard and start over
                  </button>
                </Show>
                <Show when={phase() === "failed"}>
                  <button class="btn-ghost" onClick={reset}>
                    Back to start
                  </button>
                </Show>
              </div>

              <Show when={phase() === "failed" && !checksumFailed()}>
                <p class="text-xs text-faint">
                  {percent(progress().bytes / Math.max(1, info().size))} kept. Ask the sender for a
                  new code to resume.
                </p>
              </Show>
            </div>
          </div>
        )}
      </Show>

      <Show when={notice()}>
        <p class="rounded-xl border border-accent/25 bg-accent/[0.07] px-4 py-3 text-sm text-accent">
          {notice()}
        </p>
      </Show>
    </div>
  );
}
