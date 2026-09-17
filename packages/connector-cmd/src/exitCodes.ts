/**
 * What `cmd` means by the code it exits with (spec 5.1).
 */

/**
 * Every exit code spec 5.1 names, as the sentence the user reads and whether
 * the thread is done for. `fatal: false` is the difference between "the turn
 * failed, try again" and "this session is over": the three transport failures
 * (rate limit, network, api 5xx) are worth retrying, so they leave the session
 * alive for the supervisor to back off against. 0 and 130 are not failures at
 * all and are absent on purpose.
 */
export const EXIT_MESSAGES: Readonly<
  Record<number, { readonly message: string; readonly fatal: boolean }>
> = {
  1: { message: "cmd failed — see the output above", fatal: true },
  3: { message: "command code is not authenticated — run `cmd login`", fatal: true },
  4: {
    message: "command code refused the tool call: permission denied by its own rules",
    fatal: true,
  },
  5: { message: "rate limited by command code — wait a moment and send again", fatal: false },
  6: { message: "could not reach command code — check the network and send again", fatal: false },
  7: { message: "command code's API returned a server error — send again", fatal: false },
  8: { message: "stopped at the turn limit (--max-turns)", fatal: false },
  9: { message: "command code produced no response", fatal: true },
  10: {
    message: "insufficient credits — top up at https://commandcode.ai/billing and retry",
    fatal: true,
  },
};
