/**
 * Replays the agent-browser recordings against the bridge router.
 *
 * The client side is never invented: every command is a frame the real
 * agent-browser 0.38.1 sent through the real bridge
 * (`packages/testkit/fixtures/agent-browser/`). What is faked is the Electron
 * side — `FakeGuestPort` stands in for the webviews and their debuggers, and
 * answers a forwarded command with the result the real guest gave in the
 * recording.
 *
 * Ids are per run. The router hands out the port's session and target ids,
 * so the replay learns each recorded id's live counterpart from the recorded
 * reply to the same request and rewrites later frames through that map —
 * the way the Command Code replayer puts `<HOME>` back.
 */

import { readFrames, readManifest, type RecordedFrame } from "@OpenAde/testkit/recording";

import {
  makeSerialQueue,
  openBridgeSession,
  type BridgeSession,
  type GuestEvent,
  type GuestInfo,
  type GuestPort,
} from "../bridgeSession";

export const VERSION = {
  protocolVersion: "1.3",
  product: "Chrome/152.0.7977.78",
  revision: "",
  userAgent: "Mozilla/5.0 Electron/44.3.0",
  jsVersion: "15.2.124.19",
};

/** The port the recordings' `<SITE_PORT>` is put back as. */
const SITE_PORT = "4173";

type Call =
  | {
      readonly op: "send";
      readonly wcId: number;
      readonly method: string;
      readonly focused: boolean;
    }
  | { readonly op: "attachChild" | "reload" | "closeTab" | "selectTab"; readonly wcId: number }
  | { readonly op: "detachChild"; readonly wcId: number; readonly sessionId: string }
  | { readonly op: "createTab"; readonly threadId: string; readonly url: string };

interface FakeGuest {
  readonly threadId: string;
  info: GuestInfo;
}

/** The Electron side, faked: guests, their sessions, and a log of what was asked. */
export class FakeGuestPort implements GuestPort {
  readonly calls: Array<Call> = [];
  readonly guests = new Map<number, FakeGuest>();
  /** Every target the port ever had, closed ones included, by thread. */
  readonly threadOfTarget = new Map<string, string>();
  private readonly listeners = new Set<(event: GuestEvent) => void>();
  private nextWcId = 1;
  private nextSession = 1;
  private focused: number | null = null;
  /** What the next forwarded command resolves with. */
  answer: unknown = {};
  /** When set, `withFocus` waits on it before running the operation. */
  focusGate: (() => Promise<void>) | null = null;
  maxConcurrentFocus = 0;
  private concurrentFocus = 0;

  addGuest(threadId: string, targetId: string, url = "", title = ""): GuestInfo {
    const info = { wcId: this.nextWcId++, targetId, url, title };
    this.guests.set(info.wcId, { threadId, info });
    this.threadOfTarget.set(targetId, threadId);
    this.emit({ type: "created", threadId, guest: info });
    return info;
  }

  destroyGuest(wcId: number): void {
    const guest = this.guests.get(wcId);
    if (guest !== undefined) {
      this.guests.delete(wcId);
      this.emit({
        type: "destroyed",
        threadId: guest.threadId,
        wcId,
        targetId: guest.info.targetId,
      });
    }
  }

  emit(event: GuestEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  readonly guestsOf = (threadId: string): ReadonlyArray<GuestInfo> =>
    [...this.guests.values()].filter((g) => g.threadId === threadId).map((g) => g.info);

  readonly send = async (wcId: number, method: string): Promise<unknown> => {
    this.calls.push({ op: "send", wcId, method, focused: this.focused === wcId });
    return this.answer;
  };

  readonly attachChild = async (wcId: number): Promise<string> => {
    this.calls.push({ op: "attachChild", wcId });
    return `SESSION-${this.nextSession++}`;
  };

  readonly detachChild = async (wcId: number, sessionId: string): Promise<void> => {
    this.calls.push({ op: "detachChild", wcId, sessionId });
  };

  readonly onEvent = (listener: (event: GuestEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly reload = async (wcId: number): Promise<void> => {
    this.calls.push({ op: "reload", wcId });
  };

  readonly createTab = async (threadId: string, url: string): Promise<GuestInfo> => {
    this.calls.push({ op: "createTab", threadId, url });
    return this.addGuest(threadId, `CREATED-${this.nextWcId}`, url);
  };

  readonly closeTab = async (wcId: number): Promise<void> => {
    this.calls.push({ op: "closeTab", wcId });
    this.destroyGuest(wcId);
  };

  readonly selectTab = async (wcId: number): Promise<void> => {
    this.calls.push({ op: "selectTab", wcId });
  };

  readonly withFocus = async <T>(wcId: number, operation: () => Promise<T>): Promise<T> => {
    this.concurrentFocus += 1;
    this.maxConcurrentFocus = Math.max(this.maxConcurrentFocus, this.concurrentFocus);
    try {
      await this.focusGate?.();
      this.focused = wcId;
      return await operation();
    } finally {
      this.focused = null;
      this.concurrentFocus -= 1;
    }
  };
}

type Message = Readonly<Record<string, unknown>>;

/** A session wired to a fake port, with every message it sent kept in order. */
export const openSession = (
  threadId: string,
  port: FakeGuestPort = new FakeGuestPort(),
): { port: FakeGuestPort; session: BridgeSession; sent: Array<Message> } => {
  const sent: Array<Message> = [];
  const session = openBridgeSession({
    threadId,
    port,
    version: VERSION,
    inputQueue: makeSerialQueue(),
    emit: (message) => sent.push(message),
  });
  return { port, session, sent };
};

/** The reply the session sent to request `id`. */
export const replyTo = (sent: ReadonlyArray<Message>, id: number): Message | undefined =>
  sent.find((message) => message["id"] === id && message["method"] === undefined);

const restore = (frame: RecordedFrame): Message =>
  JSON.parse(JSON.stringify(frame.data).replaceAll("<SITE_PORT>", SITE_PORT)) as Message;

const rewrite = (value: unknown, aliases: ReadonlyMap<string, string>): unknown => {
  if (typeof value === "string") return aliases.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewrite(item, aliases));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewrite(item, aliases)]),
    );
  }
  return value;
};

const field = (message: Message | undefined, ...path: ReadonlyArray<string>): unknown => {
  let value: unknown = message;
  for (const key of path) {
    value = typeof value === "object" && value !== null ? (value as Message)[key] : undefined;
  }
  return value;
};

export interface Replayed {
  readonly threadId: string;
  readonly port: FakeGuestPort;
  readonly session: BridgeSession;
  /** Every message the router sent the client. */
  readonly sent: ReadonlyArray<Message>;
  /** Each recorded client command beside the router's live reply. */
  readonly exchanges: ReadonlyArray<{
    readonly request: Message;
    readonly recorded: Message | undefined;
    readonly live: Message | undefined;
  }>;
  /** A guest of another thread that was live the whole time. */
  readonly foreign: GuestInfo;
}

/**
 * Plays a scenario's client frames into a router over a fake port seeded
 * with the recording's tabs and one guest of another thread. A popup — a
 * `targetCreated` the client never asked for — is added to the fake port at
 * the point the recording shows it.
 */
export const replayScenario = async (scenario: string): Promise<Replayed> => {
  const manifest = readManifest<{
    readonly threadId: string;
    readonly tabs: ReadonlyArray<{ readonly targetId: string; readonly url: string }>;
  }>("agent-browser", scenario);
  const frames = readFrames("agent-browser", scenario).map((frame) => ({
    frame,
    data: restore(frame),
  }));
  const { port, session, sent } = openSession(manifest.threadId);
  const foreign = port.addGuest("another-thread", "FOREIGN-TARGET", "https://other.example/");
  for (const tab of manifest.tabs) port.addGuest(manifest.threadId, tab.targetId, tab.url);

  const aliases = new Map<string, string>();
  const exchanges: Array<Replayed["exchanges"][number]> = [];
  for (const [index, { frame, data }] of frames.entries()) {
    if (frame.dir === "to-harness") {
      const created = field(data, "params", "targetInfo", "targetId");
      const known = (id: unknown) =>
        aliases.has(String(id)) || [...port.guests.values()].some((g) => g.info.targetId === id);
      if (data["method"] === "Target.targetCreated" && !known(created)) {
        port.addGuest(manifest.threadId, String(created));
      }
      continue;
    }
    const recorded = frames
      .slice(index + 1)
      .find(
        (later) =>
          later.frame.dir === "to-harness" &&
          later.frame.channel === frame.channel &&
          later.data["id"] === data["id"] &&
          later.data["method"] === undefined,
      )?.data;
    port.answer = field(recorded, "result") ?? {};
    const request = rewrite(data, aliases) as Message;
    await session.receive(request);
    const live = replyTo(sent, Number(data["id"]));
    for (const key of ["sessionId", "targetId"]) {
      const was = field(recorded, "result", key);
      const now = field(live, "result", key);
      if (typeof was === "string" && typeof now === "string") aliases.set(was, now);
    }
    exchanges.push({ request, recorded, live });
  }
  return { threadId: manifest.threadId, port, session, sent, exchanges, foreign };
};
