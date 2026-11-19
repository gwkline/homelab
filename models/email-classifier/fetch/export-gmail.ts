/**
 * Gmail metadata export for the email action classifier.
 *
 * Runs inside an Executor MCP execute() call (QuickJS). Read-only: no
 * elicitation pauses, no writes. Emits one compact JSON line per message:
 *   {"L":[labelIds],"d":internalDateMs,"f":From,"i":id,"n":snippet,
 *    "s":Subject,"t":threadId}
 *
 * MODE selects the step; ids for FETCH mode are passed inline because the
 * archived list pagination eats most of a session's Gmail budget (see
 * fetch/README.md).
 */

interface Header {
  name: string;
  value?: string;
}
interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds?: string[];
  snippet?: string;
  payload?: { headers?: Header[] };
}
type Envelope<T> = { ok: true; data: T } | { ok: false; error: unknown };
interface MsgTool {
  get: (args: Record<string, unknown>) => Promise<Envelope<GmailMessage>>;
  list: (
    args: Record<string, unknown>
  ) => Promise<
    Envelope<{ messages?: { id: string }[]; nextPageToken?: string }>
  >;
}
interface ThreadTool {
  get: (
    args: Record<string, unknown>
  ) => Promise<Envelope<{ messages?: GmailMessage[] }>>;
}

// The executor exposes integrations as an untyped lazy proxy; one cast at
// the boundary keeps the rest of the file type-clean.
const gmail = (
  tools as unknown as {
    google_gmail: {
      org: {
        localgmail: {
          gmail: { users: { messages: MsgTool; threads: ThreadTool } };
        };
      };
    };
  }
).google_gmail.org.localgmail.gmail.users;
const M = gmail.messages;
const T = gmail.threads;

// QuickJS has no async utilities beyond promises; a promise factory is the
// only awaitable timer.
const sleep = (ms: number): Promise<void> => {
  if (typeof setTimeout !== "function") {
    return Promise.resolve();
  }
  // QuickJS has no timer API besides the promise constructor; the sandbox
  // would reject anything richer anyway.
  // eslint-disable promise/avoid-new -- a promise factory is the only awaitable timer in the sandbox
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const MODE = "LIST" as "LIST" | "FETCH_ARCHIVE" | "FETCH_THREADS";
const ARCHIVE_QUERY = "in:archive -in:inbox -in:sent after:2025/05/19";
// inline for FETCH_ARCHIVE / FETCH_THREADS
const TARGET_IDS: string[] = [];
// sample every Nth archived id
const STRIDE = 10;
// concurrent gets per batch: ~25-30 req/s, under quota
const BATCH = 6;
const GAP_MS = 50;

const compact = (m: GmailMessage) => {
  const hdrs = m.payload?.headers ?? [];
  const pick = (n: string) => hdrs.find((h) => h.name === n)?.value ?? "";
  return JSON.stringify({
    L: m.labelIds ?? [],
    d: Number(m.internalDate) || 0,
    f: pick("From").slice(0, 90),
    i: m.id,
    n: (m.snippet ?? "").slice(0, 170),
    s: pick("Subject").slice(0, 110),
    t: m.threadId,
  });
};

// Two attempts, no loop: the executor's Gmail connection dies mid-call
// (HTTP 403) and a short backoff often recovers it within the same session.
const fetchOne = async (id: string): Promise<GmailMessage | null> => {
  const attempt = () =>
    M.get({
      format: "metadata",
      id,
      metadataHeaders: ["From", "Subject"],
      userId: "me",
    });
  const first = await attempt();
  if (first.ok) {
    return first.data;
  }
  await sleep(200);
  const second = await attempt();
  if (!second.ok) {
    console.log(`ARCH_GET_ERR ${id}`);
    return null;
  }
  return second.data;
};

// Paced batch runner: concurrent gets within a batch, a gap between batches,
// recursion instead of a loop. Staying under the Gmail per-user burst limit
// is the whole design (fetch/README.md) — Promise.all over everything would
// trip the executor's connection mid-call.
const runPaced = async <T>(
  items: T[],
  start: number,
  handle: (item: T) => Promise<void>
): Promise<void> => {
  if (start >= items.length) {
    return;
  }
  const chunk = items.slice(start, start + BATCH);
  await Promise.all(chunk.map(handle));
  await sleep(GAP_MS);
  await runPaced(items, start + BATCH, handle);
};

const listArchiveManifest = async () => {
  const ids: string[] = [];
  // Pagination is inherently sequential (each page needs the previous
  // token), so it also runs as recursion.
  const page = async (p: number, tok?: string) => {
    if (p >= 60) {
      return;
    }
    const args: Record<string, unknown> = {
      maxResults: 500,
      q: ARCHIVE_QUERY,
      userId: "me",
    };
    if (tok) {
      args.pageToken = tok;
    }
    const r = await M.list(args);
    if (!r.ok) {
      console.log(
        `ARCH_LIST_FAIL p${p} ${JSON.stringify(r.error).slice(0, 200)}`
      );
      return;
    }
    ids.push(...(r.data?.messages ?? []).map((m) => m.id));
    if (!r.data?.nextPageToken) {
      return;
    }
    await page(p + 1, r.data.nextPageToken);
  };
  await page(0);
  console.log(`TOTAL_SEEN ${ids.length}`);
  const sampled = ids.filter((_, i) => i % STRIDE === 0);
  for (let i = 0; i < sampled.length; i += 500) {
    console.log(`IDS ${i} ${sampled.slice(i, i + 500).join(",")}`);
  }
};

const fetchThreads = async (ids: string[]) => {
  await runPaced(ids, 0, async (tid) => {
    const r = await T.get({
      format: "metadata",
      id: tid,
      metadataHeaders: ["From", "Subject"],
      userId: "me",
    });
    if (!r.ok) {
      console.log(`THREAD_ERR ${tid}`);
      return;
    }
    const msgs = (r.data?.messages ?? []).slice(0, 60).map((m) => {
      const hdrs = m.payload?.headers ?? [];
      const pick = (n: string) => hdrs.find((h) => h.name === n)?.value ?? "";
      return {
        L: m.labelIds ?? [],
        d: Number(m.internalDate) || 0,
        f: pick("From").slice(0, 90),
        i: m.id,
        n: (m.snippet ?? "").slice(0, 170),
        s: pick("Subject").slice(0, 110),
      };
    });
    console.log(`THREAD ${JSON.stringify({ m: msgs, t: tid })}`);
  });
};

const main = async () => {
  if (MODE === "LIST") {
    await listArchiveManifest();
  } else if (MODE === "FETCH_ARCHIVE") {
    await runPaced(TARGET_IDS, 0, async (id) => {
      const m = await fetchOne(id);
      if (m) {
        console.log(compact(m));
      }
    });
  } else {
    await fetchThreads(TARGET_IDS);
  }
};
await main();
