import QRCode from "qrcode";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { createSession, deleteSession, type EncryptionPolicy } from "../lib/api";
import { formatCode, pickWords } from "../lib/words";
import { bytes, percent } from "../lib/format";
import { hashBlob } from "../lib/sha256";
import { runSender, type Phase, type SecurityInfo, type TransferHandle } from "../lib/transfer";
import { cx } from "../lib/cx";
import { Icon, icons, PhasePill, ProgressBar, SecurityNote, Toggle, TransferStats } from "./ui";

/**
 * The whole code lives in the fragment, which browsers never send to a server —
 * so the two secret words reach the other device without the signalling server
 * ever seeing them, exactly as when they are read aloud.
 */
function shareLink(code: string): string {
  return `${location.origin}${location.pathname}#${code}`;
}

/**
 * Draws the QR once the canvas is mounted — the canvas lives inside a `Show`
 * that renders after the code is set, so drawing it synchronously would find
 * an empty ref.
 */
function QrCanvas(props: { value: string }) {
  let canvas: HTMLCanvasElement | undefined;
  createEffect(
    () => props.value,
    (value) => {
      if (!canvas || !value) return;
      void QRCode.toCanvas(canvas, value, {
        width: 208,
        margin: 1,
        color: {
          dark: document.documentElement.classList.contains("light") ? "#1b2430" : "#e2e8f0",
          light: "#00000000",
        },
        errorCorrectionLevel: "M",
      });
    },
  );
  return <canvas ref={canvas} class="size-52" />;
}

export default function SendTab(props: {
  policy: EncryptionPolicy;
  onActiveChange?: (active: boolean) => void;
}) {
  const [file, setFile] = createSignal<File | null>(null);
  const [hashProgress, setHashProgress] = createSignal(0);
  const [hashing, setHashing] = createSignal(false);
  const [code, setCode] = createSignal("");
  const [digest, setDigest] = createSignal("");
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [detail, setDetail] = createSignal<string>();
  const [security, setSecurity] = createSignal<SecurityInfo>();
  // Only consulted when the server leaves the choice to us.
  const [encrypt, setEncrypt] = createSignal(true);
  const [progress, setProgress] = createSignal({ bytes: 0, total: 0, bytesPerSecond: 0 });
  const [dragging, setDragging] = createSignal(false);
  const [copied, setCopied] = createSignal<"code" | "link">();

  let handle: TransferHandle | undefined;

  onCleanup(() => handle?.cancel());

  // Once a file is being fingerprinted or offered, the send flow owns the
  // screen — the parent hides the receive section while this is true.
  createEffect(
    () => hashing() || !!code(),
    (active) => {
      // No implicit return: a Solid effect that returns a value has it called as
      // a cleanup, and the setter's return (a boolean) is not callable.
      props.onActiveChange?.(active);
    },
  );

  const reset = () => {
    handle?.cancel();
    handle = undefined;
    // Only the nameplate exists server-side, so that is what gets retired.
    if (code()) void deleteSession(code().split("-")[0]);
    setCode("");
    setDigest("");
    setSecurity(undefined);
    setPhase("idle");
    setDetail(undefined);
    setProgress({ bytes: 0, total: 0, bytesPerSecond: 0 });
  };

  /**
   * Hashes the file, registers it, and starts waiting for a receiver.
   * `knownDigest` skips the hashing pass when re-offering a file we already
   * fingerprinted, which matters once files get large.
   */
  const offer = async (chosen: File, knownDigest?: string) => {
    reset();
    setFile(chosen);
    try {
      // The digest is the resume key on the other side, so it is computed before
      // anything is offered — a different file can never reuse a record.
      let sha256 = knownDigest;
      if (!sha256) {
        setHashing(true);
        setHashProgress(0);
        sha256 = await hashBlob(chosen, setHashProgress);
        setHashing(false);
      }
      setDigest(sha256);

      const { nameplate } = await createSession({
        name: chosen.name,
        size: chosen.size,
        mime: chosen.type || "application/octet-stream",
        sha256,
      });

      // The server allocated the number; the words are ours alone and become
      // the password that authenticates the key exchange.
      const words = pickWords();
      const issued = formatCode(nameplate, words);
      setCode(issued);

      handle = runSender({
        file: chosen,
        nameplate,
        words,
        encrypt: encrypt(),
        policy: props.policy,
        events: {
          onPhase: (next, why) => {
            setPhase(next);
            setDetail(why);
          },
          onSecurity: setSecurity,
          onProgress: setProgress,
          onError: (error) => setDetail(error.message),
        },
      });
    } catch (error) {
      setHashing(false);
      setPhase("failed");
      setDetail(error instanceof Error ? error.message : String(error));
    }
  };

  /** A failed attempt gets a fresh code for the same file; the receiver resumes. */
  const reissue = () => {
    const chosen = file();
    const known = digest();
    if (chosen) void offer(chosen, known || undefined);
  };

  const copy = async (what: "code" | "link") => {
    const text = what === "code" ? code() : shareLink(code());
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(undefined), 1600);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer?.files?.[0];
    if (dropped) void offer(dropped);
  };

  return (
    <div class="space-y-4">
      <Show when={!code() && !hashing()}>
        <label
          class={cx(
            "card flex cursor-pointer flex-col items-center gap-2 border-dashed px-6 py-8 text-center transition",
            dragging() && "border-accent/60 bg-accent/[0.06]",
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <Icon path={icons.file} class="size-6 text-faint" />
          <div>
            <p class="font-medium text-ink">Drop a file here or browse</p>
            <p class="mt-0.5 text-sm text-faint">Transfers directly to the other device</p>
          </div>
          <input
            type="file"
            class="hidden"
            onChange={(event) => {
              const chosen = event.currentTarget.files?.[0];
              if (chosen) void offer(chosen);
            }}
          />
        </label>

        <Show when={props.policy === "optional"}>
          <div class="card px-6 py-5">
            <Toggle
              checked={encrypt()}
              onChange={setEncrypt}
              label="End-to-end encryption"
              hint="Adds an AES-256-GCM layer on top of transport encryption"
            />
          </div>
        </Show>
        <Show when={props.policy === "off"}>
          <p class="px-1 text-xs text-faint">
            End-to-end encryption is disabled on this server. Transfers use transport encryption only.
          </p>
        </Show>
      </Show>

      <Show when={hashing()}>
        <div class="card space-y-3 p-6">
          <div class="flex items-center justify-between text-sm">
            <span class="font-medium text-ink">Fingerprinting file</span>
            <span class="tabular-nums text-muted">{percent(hashProgress())}</span>
          </div>
          <ProgressBar fraction={hashProgress()} active tone="sky" />
          <p class="text-xs text-faint">Computing SHA-256 checksum</p>
        </div>
      </Show>

      <Show when={code()}>
        <div class="card overflow-hidden">
          <div class="flex flex-col gap-6 p-6 sm:flex-row sm:items-center">
            <div class="min-w-0 flex-1 space-y-4">
              <div class="min-w-0">
                <p class="truncate font-medium text-ink" title={file()?.name}>
                  {file()?.name}
                </p>
                <p class="text-sm text-faint">{bytes(file()?.size ?? 0)}</p>
              </div>

              <div>
                <p class="text-xs font-medium tracking-wide text-faint uppercase">
                  Transfer code
                </p>
                <p class="mt-1.5 font-mono text-2xl break-words text-accent sm:text-3xl">
                  {code()}
                </p>
              </div>

              <div class="flex flex-wrap gap-2">
                <button class="btn-ghost" onClick={() => void copy("code")}>
                  <Icon path={copied() === "code" ? icons.check : icons.copy} class="size-4" />
                  {copied() === "code" ? "Copied" : "Copy code"}
                </button>
                <button class="btn-ghost" onClick={() => void copy("link")}>
                  <Icon path={copied() === "link" ? icons.check : icons.copy} class="size-4" />
                  {copied() === "link" ? "Copied" : "Copy link"}
                </button>
              </div>
            </div>

            <div class="flex flex-col items-center gap-2">
              <div class="rounded-2xl border border-line bg-inset p-3">
                <QrCanvas value={shareLink(code())} />
              </div>
              <p class="text-xs text-faint">Scan to receive</p>
            </div>
          </div>

          <div class="space-y-4 border-t border-line bg-inset px-6 py-5">
            <PhasePill phase={phase()} detail={detail()} />

            <Show when={phase() === "transferring" || progress().bytes > 0}>
              <TransferStats
                received={progress().bytes}
                total={progress().total || (file()?.size ?? 0)}
                bytesPerSecond={progress().bytesPerSecond}
                active={phase() === "transferring"}
              />
            </Show>

            <Show when={security()}>{(info) => <SecurityNote info={info()} />}</Show>

            <Show when={phase() === "complete"}>
              <p class="text-sm text-accent">
                The file has been received. Generate a new code to send the same file to someone else.
              </p>
            </Show>

            <div class="flex flex-wrap gap-2">
              <Show
                when={
                  phase() === "failed" || phase() === "cancelled" || phase() === "complete"
                }
              >
                <button class="btn-primary" onClick={reissue}>
                  <Icon path={icons.refresh} class="size-4" />
                  New code for the same file
                </button>
              </Show>
              <button class="btn-ghost" onClick={reset}>
                Send another file
              </button>
            </div>

            <Show when={phase() === "failed"}>
              <p class="text-xs text-faint">Progress is kept. A new code resumes from the first missing chunk.</p>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
