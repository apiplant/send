import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { cx } from "../lib/cx";
import { theme, toggleTheme } from "../lib/theme";
import { bytes, eta, percent, rate } from "../lib/format";
import type { Phase, SecurityInfo } from "../lib/transfer";

export function ProgressBar(props: { fraction: number; active?: boolean; tone?: "accent" | "sky" }) {
  return (
    <div class="h-2 w-full overflow-hidden rounded-full bg-inset ring-1 ring-inset ring-line">
      <div
        class={cx(
          "h-full rounded-full transition-[width] duration-300 ease-out",
          props.tone === "sky" ? "bg-info" : "bg-accent",
          props.active && "bar-active",
        )}
        style={{ width: percent(props.fraction) }}
      />
    </div>
  );
}

/** Progress line shared by both directions: percentage, throughput and ETA. */
export function TransferStats(props: {
  received: number;
  total: number;
  bytesPerSecond: number;
  active?: boolean;
}) {
  const fraction = () => (props.total > 0 ? props.received / props.total : 0);
  return (
    <div class="space-y-2">
      <ProgressBar fraction={fraction()} active={props.active} />
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted">
        <span class="tabular-nums">
          <span class="font-medium text-ink">{percent(fraction())}</span>
          <span class="mx-2 text-faint">·</span>
          {bytes(props.received)} of {bytes(props.total)}
        </span>
        <Show when={props.active}>
          <span class="tabular-nums">
            {rate(props.bytesPerSecond)}
            <span class="mx-2 text-faint">·</span>
            {eta(props.total - props.received, props.bytesPerSecond)}
          </span>
        </Show>
      </div>
    </div>
  );
}

const PHASE_LABELS: Record<Phase, { label: string; class: string }> = {
  idle: { label: "Idle", class: "text-muted" },
  waiting: { label: "Waiting for the other device", class: "text-warn" },
  connecting: { label: "Connecting", class: "text-info" },
  transferring: { label: "Transferring", class: "text-accent" },
  verifying: { label: "Verifying checksum", class: "text-info" },
  complete: { label: "Complete", class: "text-accent" },
  failed: { label: "Failed", class: "text-danger" },
  cancelled: { label: "Cancelled", class: "text-muted" },
};

export function PhasePill(props: { phase: Phase; detail?: string }) {
  const info = () => PHASE_LABELS[props.phase];
  const pulsing = () => ["waiting", "connecting", "transferring", "verifying"].includes(props.phase);
  return (
    <div class="flex items-center gap-2 text-sm">
      <span
        class={cx("size-2 rounded-full bg-current", info().class, pulsing() && "animate-pulse")}
        aria-hidden="true"
      />
      <span class={info().class}>{info().label}</span>
      <Show when={props.detail}>
        <span class="text-faint">— {props.detail}</span>
      </Show>
    </div>
  );
}

/**
 * Says how well protected this particular transfer is: either a key that the
 * signalling server provably cannot know, or — where the deployment turned the
 * end-to-end layer off — the data channel's own transport encryption.
 */
export function SecurityNote(props: { info: SecurityInfo }) {
  const level = () =>
    props.info.encrypted
      ? {
          tone: "border-accent/25 bg-accent/[0.07] text-accent",
          title: "End-to-end encrypted, code-authenticated",
          body: "Key agreed via SPAKE2 using the words in your code. The server never saw them.",
        }
      : {
          tone: "border-warn/30 bg-warn/10 text-warn",
          title: "Transport encryption only",
          body: "End-to-end encryption is disabled. Bytes are encrypted in transit by the data channel.",
        };

  return (
    <div class={cx("rounded-xl border px-3.5 py-3 text-xs leading-relaxed", level().tone)}>
      <div class="font-medium">{level().title}</div>
      <p class="mt-1 text-muted">{level().body}</p>
      <Show when={props.info.fingerprint}>
        <div class="mt-2 font-mono tracking-wider text-muted">{props.info.fingerprint}</div>
      </Show>
    </div>
  );
}

/** A labelled switch, used for the optional end-to-end encryption toggle. */
export function Toggle(props: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label class="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={props.checked ? "true" : "false"}
        aria-label={props.label}
        disabled={props.disabled}
        onClick={() => props.onChange(!props.checked)}
        class={cx(
          "mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors disabled:opacity-40",
          props.checked ? "bg-accent" : "bg-surface-2",
        )}
      >
        <span
          class={cx(
            "block size-4 rounded-full bg-inset transition-transform",
            props.checked && "translate-x-4",
          )}
        />
      </button>
      <span class="text-sm">
        <span class="text-ink">{props.label}</span>
        <Show when={props.hint}>
          <span class="mt-0.5 block text-xs text-faint">{props.hint}</span>
        </Show>
      </span>
    </label>
  );
}

export function EmptyState(props: { icon: JSX.Element; title: string; children?: JSX.Element }) {
  return (
    <div class="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div class="text-faint">{props.icon}</div>
      <p class="font-medium text-muted">{props.title}</p>
      <p class="max-w-sm text-sm text-faint">{props.children}</p>
    </div>
  );
}

export function Icon(props: { path: string; class?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class ?? "size-5"}
      aria-hidden="true"
      innerHTML={props.path}
    />
  );
}

const APIPLANT_URL = "https://apiplant.com";

/**
 * The mark: a thin horizontal portal near the top, with a square file tumbling
 * down below it at 45° — a file arriving from somewhere else.
 */
export function PortalMark(props: { class?: string }) {
  return (
    <svg viewBox="0 0 24 24" class={props.class ?? "size-6"} aria-hidden="true" fill="none">
      <g
        stroke="currentColor"
        stroke-linejoin="round"
        stroke-linecap="round"
        stroke-width="1.5"
        transform="translate(12 12.5) scale(1.08) translate(-12 -12.5)"
      >
        {/* portal — a thin horizontal ellipse spanning the width */}
        <ellipse cx="12" cy="4.4" rx="9.6" ry="2.3" stroke-width="1.4" />
        <ellipse cx="12" cy="4.4" rx="5.9" ry="1.1" stroke-width="0.8" opacity="0.35" />
        {/* square file tumbling down at 45°, clear of the portal */}
        <g transform="rotate(45 12 15)">
          <path d="M7.5 11h5l3 3v5a1 1 0 0 1-1 1H7.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" />
          <path d="M12.5 11l3 3h-3z" fill="currentColor" stroke="none" />
          <path d="M9 15.5h4.5M9 17.8h4.5" stroke-width="1" opacity="0.8" />
        </g>
      </g>
    </svg>
  );
}

/** `apiplant send`, two-tone the way the studio titles itself. */
export function Wordmark() {
  return (
    <a
      href="https://send.apiplant.com"
      class="inline-flex items-center gap-3"
      aria-label="apiplant send home"
    >
      <span class="grid size-10 place-items-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
        <PortalMark class="size-6" />
      </span>
      <span class="text-xl font-semibold tracking-tight text-ink">
        apiplant <span class="text-accent">send</span>
      </span>
    </a>
  );
}

/** The site's single commercial link: the team behind apiplant is for hire. */
export function HireUs(props: { class?: string }) {
  return (
    <a
      href={APIPLANT_URL}
      target="_blank"
      rel="noreferrer noopener"
      class={cx("btn-hire", props.class)}
    >
      Hire us
    </a>
  );
}

export function ThemeToggle() {
  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={theme() === "dark" ? "Switch to light" : "Switch to dark"}
      aria-label={theme() === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      class="inline-flex size-9 items-center justify-center rounded-lg border border-line bg-surface-2 text-muted transition-colors hover:text-ink"
    >
      <Show
        when={theme() === "dark"}
        fallback={
          <svg viewBox="0 0 24 24" class="size-4" fill="currentColor" aria-hidden="true">
            <path d="M12 3a9 9 0 1 0 9 9c0-.34-.02-.67-.05-1A7 7 0 0 1 13 4.05c-.33-.03-.66-.05-1-.05Z" />
          </svg>
        }
      >
        <svg
          viewBox="0 0 24 24"
          class="size-4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path
            stroke-linecap="round"
            d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.1 5.1l1.4 1.4M17.5 17.5l1.4 1.4M18.9 5.1l-1.4 1.4M6.5 17.5l-1.4 1.4"
          />
        </svg>
      </Show>
    </button>
  );
}

export const icons = {
  send: '<path d="M4 12h8m0 0-3-3m3 3-3 3"/><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/>',
  download: '<path d="M12 4v10m0 0 4-4m-4 4-4-4"/><path d="M4 18h16"/>',
  database:
    '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
  refresh: '<path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5"/><path d="M20 20v-4.5h-4.5"/>',
  shield: '<path d="M12 3 5 6v6c0 4.4 3 8.3 7 9 4-0.7 7-4.6 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
};
