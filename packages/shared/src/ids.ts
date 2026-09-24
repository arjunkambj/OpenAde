/**
 * UUIDv7 (RFC 9562 section 5.7) with no dependencies.
 *
 * Every identifier in Poseidon is a UUIDv7 so that ids sort by creation time:
 * event stream keys, thread ids and turn ids all rely on that ordering, and
 * SQLite indexes stay append-friendly because new keys land at the right edge.
 *
 * Layout: 48 bits of Unix milliseconds, 4 bits of version, 12 bits used as a
 * within-millisecond counter (method 2 of the RFC, which keeps ids generated in
 * the same millisecond monotonic), 2 bits of variant, 62 bits of randomness.
 */

const COUNTER_MAX = 0xfff;

let lastMillis = 0;
let counter = 0;

const randomBytes = (length: number): Uint8Array => {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
};

const toHex = (bytes: Uint8Array): string => {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
};

/**
 * Generates the next UUIDv7. Successive calls are strictly increasing, both
 * lexicographically and as byte strings, even inside a single millisecond and
 * across a clock that steps backwards.
 */
export const uuidV7 = (): string => {
  const now = Date.now();
  if (now > lastMillis) {
    lastMillis = now;
    counter = 0;
  } else {
    // Same millisecond, or a clock that went backwards: keep counting up and
    // borrow from the next millisecond once the 12-bit counter is exhausted.
    counter += 1;
    if (counter > COUNTER_MAX) {
      lastMillis += 1;
      counter = 0;
    }
  }

  const millis = lastMillis;
  const random = randomBytes(8);
  const bytes = new Uint8Array(16);

  bytes[0] = Math.floor(millis / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(millis / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(millis / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(millis / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(millis / 2 ** 8) & 0xff;
  bytes[5] = millis & 0xff;
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  bytes[8] = ((random[0] ?? 0) & 0x3f) | 0x80;
  for (let index = 1; index < 8; index += 1) {
    bytes[8 + index] = random[index] ?? 0;
  }

  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True when `value` is a well-formed, lower-case UUIDv7 string. */
export const isUuidV7 = (value: string): boolean => UUID_V7_PATTERN.test(value);

/**
 * Reads the Unix-millisecond timestamp back out of a UUIDv7. Returns undefined
 * for anything that is not a UUIDv7.
 */
export const uuidV7Millis = (value: string): number | undefined => {
  if (!isUuidV7(value)) {
    return undefined;
  }
  return Number.parseInt(value.slice(0, 8) + value.slice(9, 13), 16);
};
