import { createEffect, createSignal, For, Show } from "solid-js";
import { ago, bytes, percent } from "../lib/format";
import { listTransfers, quota, type TransferRecord } from "../lib/idb";
import { pickDestination, saveByDownload, saveToPickedFile } from "../lib/save";
import { discardAll, discardTransfer, savePickerSupported, staging } from "../lib/staging";
import { EmptyState, Icon, icons, ProgressBar } from "./ui";

export default function StorageTab(props: { version?: number; onStorageChanged?: () => void }) {
  const [records, setRecords] = createSignal<TransferRecord[]>([]);
  const [estimate, setEstimate] = createSignal<{ usage: number; quota: number } | null>(null);
  const [confirming, setConfirming] = createSignal(false);
  const [orphaned, setOrphaned] = createSignal(0);
  // Which record is being written out, and how far along — only one at a time.
  const [saving, setSaving] = createSignal<{ id: string; fraction: number }>();
  const [saveError, setSaveError] = createSignal<string>();

  const refresh = async () => {
    setRecords(await listTransfers());
    setEstimate(await quota());
    // Staged files with no record are the residue of an interrupted save; they
    // are counted separately so the number here matches what is really on disk.
    const staged = await staging.list().catch(() => []);
    setOrphaned(
      staged
        .filter((entry) => !records().some((record) => entry.file.startsWith(record.id)))
        .reduce((total, entry) => total + entry.size, 0),
    );
  };

  // Runs on mount, then again whenever another tab reports writing or freeing chunks.
  createEffect(
    () => props.version,
    () => void refresh(),
  );

  const held = () =>
    records().reduce((total, record) => total + record.receivedBytes, 0) + orphaned();

  const remove = async (record: TransferRecord) => {
    await discardTransfer(record.id);
    await refresh();
    props.onStorageChanged?.();
  };

  /** A record with every chunk present is a finished file, not a partial. */
  const isComplete = (record: TransferRecord) =>
    record.size > 0 && record.receivedBytes >= record.size;

  /**
   * Writes a finished-but-unsaved file out to the device. This one runs from a
   * click, so the save picker is available — which lets it stream and reclaim
   * the staged copy as it goes rather than duplicating the whole file.
   */
  const saveToDisk = async (record: TransferRecord) => {
    setSaveError(undefined);
    try {
      const destination = await pickDestination(record);
      if (savePickerSupported() && !destination) return; // the user cancelled

      setSaving({ id: record.id, fraction: 0 });
      if (destination) {
        await saveToPickedFile(record, destination, (fraction) =>
          setSaving({ id: record.id, fraction }),
        );
        await discardTransfer(record.id);
      } else {
        await saveByDownload(record);
      }
    } catch (error) {
      setSaveError(
        `Save interrupted: ${error instanceof Error ? error.message : String(error)}. ` +
          "Whatever was already written out is on disk; the rest can be resumed with a new code.",
      );
    } finally {
      setSaving(undefined);
      await refresh();
      props.onStorageChanged?.();
    }
  };

  const removeAll = async () => {
    await discardAll();
    setConfirming(false);
    await refresh();
    props.onStorageChanged?.();
  };

  const hasContent = () => records().length > 0 || orphaned() > 0;

  return (
    <div class="space-y-5">
      <Show
        when={hasContent()}
        fallback={
          <div class="card">
            <EmptyState icon={<Icon path={icons.database} class="size-8" />} title="Nothing stored">
              Received files are kept here until they are saved, and partial ones so
              transfers can resume.
            </EmptyState>
          </div>
        }
      >
      <div class="card p-6">
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p class="text-xs font-medium tracking-wide text-faint uppercase">
              In use by received files
            </p>
            <p class="mt-1 font-mono text-3xl text-ink">{bytes(held())}</p>
            <p class="mt-1 text-sm text-faint">
              across {records().length} {records().length === 1 ? "file" : "files"}
              <Show when={orphaned() > 0}>
                <span class="mx-2 text-faint">·</span>
                includes {bytes(orphaned())} from a finished save
              </Show>
              <Show when={estimate()}>
                {(info) => (
                  <>
                    <span class="mx-2 text-faint">·</span>
                    this site uses {bytes(info().usage)} of {bytes(info().quota)}
                  </>
                )}
              </Show>
            </p>
          </div>
          <div class="flex gap-2">
            <button class="btn-ghost" onClick={() => void refresh()}>
              <Icon path={icons.refresh} class="size-4" />
              Refresh
            </button>
            <Show
              when={confirming()}
              fallback={
                <button class="btn-danger" disabled={records().length === 0} onClick={() => setConfirming(true)}>
                  <Icon path={icons.trash} class="size-4" />
                  Clear all
                </button>
              }
            >
              <button class="btn-danger" onClick={() => void removeAll()}>
                Delete {bytes(held())}?
              </button>
              <button class="btn-ghost" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </Show>
          </div>
        </div>

        <Show when={estimate()}>
          {(info) => (
            <div class="mt-5">
              <ProgressBar fraction={info().quota > 0 ? info().usage / info().quota : 0} tone="sky" />
            </div>
          )}
        </Show>
      </div>

      <Show when={records().length > 0}>
        <ul class="space-y-3">
          <For each={records()}>
            {(record) => {
              const fraction = record.size > 0 ? record.receivedBytes / record.size : 0;
              return (
                <li class="card p-5">
                  <div class="flex flex-col-reverse gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <p class="min-w-0 truncate font-medium text-ink" title={record.name}>
                      {record.name}
                    </p>
                    <div class="flex shrink-0 items-center justify-between gap-2 sm:justify-end">
                      <Show when={isComplete(record)}>
                        <span class="chip text-accent">Complete</span>
                        <button
                          class="btn-ghost"
                          disabled={saving() !== undefined}
                          title="Write this file out to your device"
                          onClick={() => void saveToDisk(record)}
                        >
                          <Icon path={icons.download} class="size-4" />
                          Save to device
                        </button>
                      </Show>
                      <Show when={!isComplete(record)}>
                        <span class="chip tabular-nums">{percent(fraction)}</span>
                      </Show>
                      <button
                        class="btn-ghost px-2.5 py-2"
                        disabled={saving() !== undefined}
                        title="Delete this stored file"
                        aria-label={`Delete ${record.name}`}
                        onClick={() => void remove(record)}
                      >
                        <Icon path={icons.trash} class="size-4" />
                      </button>
                    </div>
                  </div>
                  <p class="mt-2 text-sm text-faint">
                    {bytes(record.receivedBytes)} of {bytes(record.size)}
                    <span class="mx-2 text-faint">·</span>
                    updated {ago(record.updatedAt)}
                  </p>
                  <div class="mt-4">
                    <ProgressBar
                      fraction={saving()?.id === record.id ? saving()!.fraction : fraction}
                      active={saving()?.id === record.id}
                    />
                  </div>
                  <Show when={saving()?.id === record.id}>
                    <p class="mt-2 text-xs text-faint">
                      Writing to device — {percent(saving()!.fraction)}.
                    </p>
                  </Show>
                  <p class="mt-3 font-mono text-[11px] break-all text-faint">
                    sha256 {record.id}
                  </p>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>

      <Show when={saveError()}>
        <p class="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {saveError()}
        </p>
      </Show>
      </Show>
    </div>
  );
}
