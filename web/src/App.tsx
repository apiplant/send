import { createSignal, onCleanup, Show } from "solid-js";
import { encryptionPolicy, loadIceServers, turnEnabled, type EncryptionPolicy } from "./lib/api";
import ReceiveTab from "./components/ReceiveTab";
import SendTab from "./components/SendTab";
import StorageTab from "./components/StorageTab";
import { HireUs, Icon, icons, ThemeToggle, Wordmark } from "./components/ui";
import { cx } from "./lib/cx";

/**
 * Storage is somewhere you go to look something up, not a half of the app, so
 * it sits in the header beside the other controls rather than splitting the
 * page in two. Transferring is what the page is for and needs no tab of its own.
 */
type View = "transfer" | "storage";

/**
 * A share link is just `#4-unicorn-waffle`. The whole code sits in the
 * fragment, which the browser never sends to a server — so the two secret words
 * travel with the link without the signalling server learning them.
 */
function parseHash(hash: string): { code: string } | null {
  const value = decodeURIComponent(hash.replace(/^#/, "")).trim();
  return value ? { code: value } : null;
}

export default function App() {
  const incoming = parseHash(location.hash);
  const [view, setView] = createSignal<View>("transfer");
  const [storageVersion, setStorageVersion] = createSignal(0);
  // Both peers read this from the same server, so they agree before handshaking.
  const [policy, setPolicy] = createSignal<EncryptionPolicy>("required");
  void encryptionPolicy().then(setPolicy);
  const [link, setLink] = createSignal(incoming);
  // True while a file is being fingerprinted or offered — the receive section
  // is hidden so the sender isn't looking at both flows at once.
  const [sending, setSending] = createSignal(false);
  // Assume a relay until /api/turn says otherwise, so the warning never flashes
  // on a working deployment while the list is still loading.
  const [turnOk, setTurnOk] = createSignal(true);
  void loadIceServers().then(() => setTurnOk(turnEnabled()));

  const bumpStorage = () => setStorageVersion((version) => version + 1);

  // Someone may paste a share link into an already-open tab.
  const onHashChange = () => {
    const parsed = parseHash(location.hash);
    if (parsed) {
      setLink(parsed);
      setView("transfer");
    }
  };
  window.addEventListener("hashchange", onHashChange);
  onCleanup(() => window.removeEventListener("hashchange", onHashChange));

  return (
    <div class="mx-auto flex min-h-full max-w-3xl flex-col px-4 py-8 sm:px-6 sm:py-12">
      <header class="mb-8 flex items-start justify-between gap-4">
        <div>
          <Wordmark />
          <p class="mt-2 whitespace-nowrap text-xs text-faint sm:text-sm">
            Device to device. Resumable. Checksum-verified.
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          {/* One control, and it always names where it goes rather than where
              you are — so from storage it reads "Transfer", not "Storage". */}
          <button
            type="button"
            onClick={() => setView(view() === "storage" ? "transfer" : "storage")}
            aria-label={view() === "storage" ? "Transfer" : "Storage"}
            title={view() === "storage" ? "Back to transfers" : "Stored files"}
            class={cx(
              "inline-flex h-9 w-9 items-center justify-center gap-2 rounded-lg border bg-surface-2",
              "text-sm transition-colors sm:w-auto sm:px-3",
              view() === "storage"
                ? "border-accent/40 text-accent"
                : "border-line text-muted hover:text-ink",
            )}
          >
            <Icon path={view() === "storage" ? icons.send : icons.database} class="size-4" />
            <span class="hidden sm:inline">{view() === "storage" ? "Transfer" : "Storage"}</span>
          </button>
          <HireUs class="hidden sm:inline-flex" />
          <ThemeToggle />
        </div>
      </header>

      <main class="flex-1">
        <Show when={!turnOk()}>
          <p class="mb-6 rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-xs text-warn">
            This server has no TURN relay, so transfers connect peer-to-peer with STUN
            only. That usually works, but can fail behind a corporate VPN or firewall,
            or between two devices on mobile networks. If a transfer never leaves
            “connecting”, try a different network.
          </p>
        </Show>
        <Show when={view() === "transfer"}>
          <div class="space-y-10">
            <Show when={!sending()}>
              <section>
                <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
                  <Icon path={icons.download} class="size-4 text-accent" />
                  Receive a file
                </h2>
                <ReceiveTab
                  policy={policy()}
                  initialCode={link()?.code}
                  onStorageChanged={bumpStorage}
                />
              </section>
            </Show>
            <section>
              <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
                <Icon path={icons.send} class="size-4 text-accent" />
                Send a file
              </h2>
              <SendTab policy={policy()} onActiveChange={setSending} />
            </section>
          </div>
        </Show>
        <Show when={view() === "storage"}>
          <StorageTab version={storageVersion()} onStorageChanged={bumpStorage} />
        </Show>
      </main>

      <footer class="mt-10 flex items-center gap-2 text-xs text-faint">
        <Icon path={icons.shield} class="size-4" />
        <span>Files transfer directly between devices. The server only sees name, size and checksum.</span>
      </footer>
    </div>
  );
}
