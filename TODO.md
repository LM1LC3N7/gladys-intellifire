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

## To check on a real fireplace

- The unit of `setpoint` in `/poll` (hundredths of °C as the library says, or whole °C as its fixture).
- Whether `time_remaining` is accepted right after `power` 1, and kept; what `power` 0 does to the timer.
- What `thermostat_setpoint` 0 does while the flame is off, and whether a setpoint lights the flame.
- The status the module answers to a wrong key (403 as for an old challenge?).
- The cookies and status of `/a/login` on iftapi.net today (204 + `user`, `auth_cookie`).
