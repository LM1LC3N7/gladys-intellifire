// -----------------------------------------------------------------------------
// The local API of the fireplace (src/constants.js PATHS): a read of
// `/poll`, and a command = a fresh challenge then its signed post. One
// request at a time is the business of the caller (src/lane.js): this client
// only chains the requests of one command.
//
// A post answered 403 is, as intellifire4py reads it, a challenge expired:
// a new challenge is asked and the post signed again, up to 10 times within
// the time of the command. Running out of time after a 403 is a failure to
// try again (`CHALLENGE`), never a refusal; 10 posts answered 403 are
// `AUTH`, which the app takes as a refused key only on other proofs (a key
// never accepted by this serial, the serial read at the address). A
// challenge older than 5 s is never posted. Reads are never retried here.
// -----------------------------------------------------------------------------

import { COMMANDS, PATHS, TIMINGS } from '../constants.js';
import { FireplaceError, ERROR_KINDS, request as httpRequest } from './http.js';
import { parseChallenge, parsePoll, signedForm } from './model.js';

/** Retry-After in ms (seconds only: the module has no clock worth comparing). */
function retryAfterOf(headers) {
  const raw = headers?.['retry-after'];
  return typeof raw === 'string' && /^\s*\d{1,6}\s*$/.test(raw) ? Number(raw) * 1000 : undefined;
}

function statusError(res) {
  const { status } = res;
  if (status === 429 || status === 503) {
    return new FireplaceError(ERROR_KINDS.RATE_LIMITED, `HTTP ${status}`, {
      status,
      retryAfter: retryAfterOf(res.headers),
    });
  }
  return new FireplaceError(ERROR_KINDS.HTTP, `HTTP ${status}`, {
    status,
    redirect: status >= 300 && status < 400,
  });
}

/** Whether a command value is within the range of the API (intellifire4py `_range_check`). */
export function inRange(command, value) {
  return Number.isInteger(value) && value >= command.min && value <= command.max;
}

export class FireplaceClient {
  constructor({ transport = httpRequest, now = () => performance.now() } = {}) {
    this.transport = transport;
    this.now = now;
  }

  async get(target, path, { timeoutMs, signal }) {
    const res = await this.transport({
      host: target.host,
      port: target.port,
      path,
      timeoutMs,
      signal,
    });
    if (res.status < 200 || res.status >= 300) {
      throw Object.assign(statusError(res), { sent: true });
    }
    return res.body;
  }

  /** `GET /poll`: the parsed state (src/intellifire/model.js parsePoll). */
  async poll(target, options) {
    const data = parsePoll(await this.get(target, PATHS.poll, options));
    if (!data) {
      throw new FireplaceError(ERROR_KINDS.PROTOCOL, 'Not a JSON object', { sent: true });
    }
    return data;
  }

  /**
   * One command: a challenge, then its signed post. `beforeSend` runs right
   * before the first byte of each post (never before a challenge, which
   * changes nothing) and may refuse it. `until` (monotonic) bounds the whole
   * command. Resolves when a post is answered 2xx; throws a FireplaceError
   * whose `sent` says whether a post may have reached the fireplace.
   */
  async command(target, credentials, command, value, { until, signal, beforeSend }) {
    if (!inRange(command, value)) {
      throw new FireplaceError(ERROR_KINDS.PROTOCOL, 'Value out of range');
    }
    let sent = false;
    const left = () => Math.round(until - this.now());
    // `post`: the error of a post keeps its own `sent` (a byte may have left);
    // a challenge is only a nonce, so its error says what the posts before did.
    const step = async (fn, post) => {
      if (left() < TIMINGS.commandMinRequest / 2) {
        throw new FireplaceError(sent ? ERROR_KINDS.TIMEOUT : ERROR_KINDS.LATE, 'No time left', {
          sent,
        });
      }
      try {
        return await fn(Math.max(1, left()));
      } catch (err) {
        if (err instanceof FireplaceError) err.sent = post ? err.sent || sent : sent;
        throw err;
      }
    };
    let forbidden = 0;
    for (let attempt = 1; ; attempt += 1) {
      const challenge = parseChallenge(
        // A challenge is only a nonce: asking for it changes nothing (`sent` stays as it was).
        await step((timeoutMs) => this.get(target, PATHS.challenge, { timeoutMs, signal }), false),
      );
      if (!challenge) {
        throw new FireplaceError(ERROR_KINDS.PROTOCOL, 'No challenge', { sent });
      }
      const receivedAt = this.now();
      const tooOld = () => this.now() - receivedAt > TIMINGS.challengeMaxAge;
      const body = signedForm(credentials, challenge, command.name, value);
      if (tooOld()) {
        // Never posted on a challenge the module may have dropped: a new one.
        if (attempt >= TIMINGS.challengeTries) {
          throw new FireplaceError(ERROR_KINDS.CHALLENGE, 'Challenges too slow', { sent });
        }
        continue;
      }
      const res = await step(
        (timeoutMs) =>
          this.transport({
            host: target.host,
            port: target.port,
            method: 'POST',
            path: PATHS.post,
            body,
            timeoutMs,
            signal,
            beforeSend: () => {
              if (tooOld()) {
                throw new Error('Challenge too old');
              }
              beforeSend?.();
              sent = true;
            },
          }),
        true,
      );
      if (res.status >= 200 && res.status < 300) {
        return { attempts: attempt };
      }
      // Answered with a refusal (a 4xx): that post was not applied. A 5xx may have been.
      sent = res.status >= 500;
      if (res.status === 403) {
        // intellifire4py: "Invalid challenge code (it may have expired)": a new challenge.
        forbidden += 1;
        if (attempt >= TIMINGS.challengeTries) {
          throw new FireplaceError(ERROR_KINDS.AUTH, 'HTTP 403', { status: 403, sent, forbidden });
        }
        if (left() < TIMINGS.commandMinRequest) {
          // Out of time is never a proof of a refused key: a failure to try again.
          throw new FireplaceError(ERROR_KINDS.CHALLENGE, 'HTTP 403, no time left', {
            status: 403,
            sent,
            forbidden,
          });
        }
        continue;
      }
      throw Object.assign(statusError(res), { sent });
    }
  }
}

/** A short reason for the status and the logs (never a body, never a header). */
export function errorReason(err) {
  if (err?.kind === ERROR_KINDS.HTTP) {
    return err.redirect ? `HTTP ${err.status} (redirect)` : `HTTP ${err.status}`;
  }
  if (err?.kind === ERROR_KINDS.AUTH || err?.kind === ERROR_KINDS.CHALLENGE) return 'HTTP 403';
  return err?.kind ?? 'error';
}

export { COMMANDS };
