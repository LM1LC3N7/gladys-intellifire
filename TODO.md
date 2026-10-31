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
- A 403 to a post signed with a fresh challenge is tried once more with a new challenge; a second 403
  is "key refused": not an attempt; the turn off is kept and leaves with a new key, a test read that
  succeeds, or a new click; no automatic retry.
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

## To check on a real fireplace

- The unit of `setpoint` in `/poll` (hundredths of °C as the library says, or whole °C as its fixture).
- Whether `time_remaining` is accepted right after `power` 1, and kept; what `power` 0 does to the timer.
- What `thermostat_setpoint` 0 does while the flame is off, and whether a setpoint lights the flame.
- Whether the end of the timer stops the thermostat mode (Gladys turns it off after the session anyway).
- The status the module answers to a wrong key (403 as for an old challenge?).
- The cookies and status of `/a/login` on iftapi.net today (204 + `user`, `auth_cookie`).
