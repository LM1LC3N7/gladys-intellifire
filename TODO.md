# TODO — IntelliFire v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1 — core** (2026-10-31): one fireplace per integration (address), `/poll` every
      interval (never sooner, even after a restart), device by serial number, flame, pilot, glass hot,
      room temperature, thermostat mode and setpoint, timer left, light level, faults; turn off never
      held back (power 0 then setpoint 0, kept in /data, checked every 15 s, 3 resends then held);
      turn on (timer always set, checked by the reads), flame height, fan speed, setpoint behind
      `allow_control` (off), decided on a fresh read, bounded; "Retrieve the key" (one cloud sign-in
      per click). Tested against a fake module only.
- [x] **Review 1 fixes** (2026-10-31), tests in `test/review-r1.test.js`: B1 a 403 is a challenge
      expired (10 new challenges per post, as intellifire4py); out of time after 403s is a failure to
      try again, never a refusal; "key refused" only on proof (10 × 403, the serial read at the
      address, a key it never accepted); a refused post is not "written"; the ack of a timer refused
      says where the turn off is. B2 the turn off belongs to a serial (in /data), follows the
      configured address, never applied nor posted to another serial. B3 the session of a turn on in
      /data, never lifted by time, resumed after a restart; the timer posted once more, then turn off.
      B4 /data opened non-blocking, regular files only, every wait bounded (2 s), the pause save not
      awaited; /data unreadable: one read at once. I1 the fire read off ends the session (a manual
      relight is never fought). I2 any save of the key, a test that succeeds or "Retrieve the key"
      lifts a refusal. I3 a setpoint posts the timer of the session first and is watched as a
      session; a thermostat session past its end is turned off. I4 tests for the mutants (two are
      equivalent, see below). M1 `gladys.config` used when `getConfig()` fails at the start, retried
      every 5 s while a turn off waits. M2 a setpoint read back different: setpoint 0; the setpoint
      feature bounded by the configuration. M3 User-Agent version from package.json. M4 texts. M5 the
      timer posted a second time before a turn off. M6 docs: the key from Home Assistant. M7 a read
      without `thermostat` is not "thermostat off".
- [x] **Review 2 fixes** (2026-10-31), tests in `test/review-r2.test.js`: B1 the turn off carries
      the serial of the device clicked; nothing posted while the last read of the address shows
      another serial; another serial's 403s never count against the key. I1 a setpoint post checks
      the option, the configuration, the turn offs, the pause, the key and the 3.5 s deadline in its
      own `beforeSend`. I2 a kept turn off checked every 15 s while the module does not answer;
      spaced up to 1 h only after repeated 403s. I3 `shutdown()` closes the app: no request, no
      timer re-armed (schedule, followUp, armStopCheck, armSession, repostTimer, config retry); the
      real-clock test bounds every wait and cleans up in `t.after`; `until()` of the helpers rejects
      when its budget is spent. I4 tests for the six surviving mutants. M1 a setpoint keeps a timer
      already running and not longer than the session (never lengthened). M2 docs say exactly when
      an other fireplace receives posts. M4 documented (see Next patch).
- [x] **Review 3 fixes** (2026-10-31), tests in `test/review-r3.test.js` and
      `test/realclock-r3.test.js` (scenario 13e on the real clock): B1 one turn off kept per fireplace
      (serial, 4 at most, all in /data, the single `stop` of an older /data read as one), never let go
      by the turn off or the turn on of another device; ten 403s prove a refused key for that serial
      only (its commands and turn off), never when the key is known to be another fireplace's (it
      accepted it, or "Retrieve the key" got it for it, in memory only); a turn off or a command is
      never signed with such a key; a check that reads no serial while the last read of the address is
      another fireplace posts nothing; the check read of a turn off is decided once (two reads in a
      row when it never left). I1 tests for the 3.5 s deadline of the setpoint post, a `getConfig()`
      failing after shutdown (re-arms nothing), a turn off of an older /data taking the serial
      clicked, and every entry point after shutdown (schedule, tick, followUp, armSession,
      repostTimer, armStopCheck, runCheck, queueStop, a new address saved). M1 a command clicked
      after shutdown is refused before any request; a turn off then is kept in /data for the next
      start. M2 the two waits of an ack in `test/review-r2.test.js` bounded (`t.until`). M3 (M4 of
      r2) still in Next patch.
- [ ] **Milestone 2 — real fireplace**: run against a real module (see "To check"), anonymized captures
      as fixtures.
- [ ] **Milestone 3 — more**: light level command, pilot command, timer command, UDP discovery
      (`network_discovery` udp), `keywords`/`countries` in the manifest once the store accepts them.

## Decisions

- Version 0.1.0 by hand (package.json, lock, manifest, `docker_image`). SDK `^0.16.0` (latest published,
  2026-10-31).
- Categories: `climate` only. No `keywords`/`countries` (store rule).
- Local API only for reads and commands; the cloud (iftapi.net) only on the "Retrieve the key" click,
  with its own User-Agent `gladys-intellifire/<version>`, never the app's nor intellifire4py's.
- The key and the user id are `secret` fields written by `setConfig` (or typed): never in /data. So a
  turn off kept in /data waits for the configuration after a restart (the only case it waits for it).
- Turn off = power 0, then thermostat setpoint 0 (best effort, skipped when the read says there is no
  thermostat): a thermostat mode never lights the flame again after a turn off from Gladys.
- A 403 to a post is a challenge expired: up to 10 new challenges per post (as intellifire4py). Ten
  403s prove a refused key only for the serial read at the address, a key it never accepted and not
  known to be another fireplace's (review r3); that serial's turn off is then kept and leaves with a
  key saved, a test read that succeeds, or a new click; no automatic retry. The other fireplaces are
  never concerned.
- One turn off kept per fireplace (serial), 4 at most (review r3): beyond, the oldest one of a
  fireplace that is neither the one clicked nor the one read at the address is let go (logged). The
  owner of the key (the serial that accepted it, or the one it was retrieved for) is kept in memory
  only: binding it to the key in /data would need a fingerprint of the key (never written), and a
  stale owner could hold back the turn off of the true one. After a restart, the turn off goes with
  the key typed until a post is accepted.
- Flame height and setpoint refused while the fireplace is off (unknown whether they light it); the fan
  allowed when off (it never lights it) but behind the option as the brief asks.
- A turn on already lit (read) sends nothing (never re-arms the timer of a fire lit elsewhere).
- The setpoint is read as hundredths of °C (intellifire4py `thermostat_setpoint_c = setpoint / 100`,
  `set_thermostat_c` sends °C × 100); a value between 1 and 499 (the anonymized fixtures carry 17) is
  unknown, never published. Temperatures are °C as the module sends them: no °F conversion.
- Light level read only in v1 (the brief lists turning on, flame, fan, setpoint as the commands).
- One fireplace per integration: the scene "5 slow targets" check of the sheet does not apply.
- 403 (review r1): intellifire4py reads it as a challenge expired and tries 10 challenges; the module
  gives no other status for a wrong key. A key is "refused" only on proof; a key that worked for a
  serial in this run is never refused by 403s.
- The setpoint is kept (the brief lists it), always paired with the timer of the session and watched
  (review r1, I3): the safer of the two options that keep the feature.
- Equivalent mutants (review r1): "a newer turn on lets a kept turn off go only if no turn off since"
  (a turn off clicked meanwhile aborts the line before the post can be accepted); "special file never
  read" (a FIFO or a directory fails the read anyway; a device file needs root to make in a test).
- Equivalent mutants (reviews r3 and r4), each held by another check on the same path: "closed:
  queueStop" (the worker of the turn offs checks `closed` first and calls the same `keepClosed`: same
  turn off kept in /data, same answer, nothing posted); "closed: connected" (`applyConfig` and
  `start` both return at once when closed); "a key known to be another fireplace's in
  `resumeStop`" (the queued turn off is refused by the same check in `sendStop` before any post: only
  the first check comes 15 s later instead of at once). The other closed guards of r3 (tick,
  runCheck, repostTimer, armSession, schedule, the config retry) are killed by tests that call them
  after `shutdown()`.

## Next patch

- /data unreadable: one read at each start (`firstWait` 0), so a restart loop reads faster than the
  interval. Keep the time of the last read elsewhere (a second small file) or wait one interval when
  the start follows a recent one.

## To check on a real fireplace

- The unit of `setpoint` in `/poll` (hundredths of °C as the library says, or whole °C as its fixture).
- Whether `time_remaining` is accepted right after `power` 1, and kept; what `power` 0 does to the timer.
- What `thermostat_setpoint` 0 does while the flame is off, and whether a setpoint lights the flame.
- Whether the end of the timer stops the thermostat mode (Gladys turns it off after the session anyway).
- The status the module answers to a wrong key (403 as for an old challenge?).
- The cookies and status of `/a/login` on iftapi.net today (204 + `user`, `auth_cookie`).
