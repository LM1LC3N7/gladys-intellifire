# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/stop.test.js             # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npx github:GladysAssistant/integration-store .   # store admission checks
```

## Architecture

```
index.js                          SDK wiring only; a turn off kept in /data restored at boot
src/handlers.js                   SDK handlers -> IntelliFireApp (shared with the tests)
src/app.js                        polling, device, states, status, commands, the turn off, the key button
src/lane.js                       one HTTP exchange at a time; the turn off first (it aborts the holder)
src/devices.js                    device and states (pure); feature roles are frozen
src/intellifire/client.js         /poll, and a command = challenge + signed post (403 retried once)
src/intellifire/model.js          strict parsers of /poll and the challenge, the signature
src/intellifire/http.js           one bounded HTTP exchange (node:http), `beforeSend`, abort, error kinds
src/intellifire/cloud.js          iftapi.net sign-in and fireplace list, for the "Retrieve the key" button only
src/store.js                      /data/intellifire-state.json: target, last read, turn off, start check, pause; no secret
src/publisher.js                  states to Gladys within 300 per minute, nothing older than 2 minutes
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       English and French runtime texts
scripts/cover.mjs                 cover.png generator (plain Node, no dependency)
test/                             node --test, the SDK's fake Gladys and test/fixtures/fakeFireplace.js
test/kit/                         gladys-testkit files, as is (clocks, loopback servers)
```

## Rules

- **External ids are forever.** Device `gladys.externalIds('intellifire', serial)`, the serial of
  `/poll` in lower case, never the address. Feature roles in `FEATURES` of `src/constants.js`, manifest
  keys (`address`, `api_key`, `user_id`, `username`, `password`, `allow_control`, `session_duration`,
  `max_temperature`, `poll_interval`, `language`, actions `test_connection`, `fetch_key`).
- **Secrets** (key, user id, password, e-mail address): never logged, never in /data, a status or an
  error. A `secret` field is "kept by Gladys in its database, never shown again", never "encrypted".
- **No switch, no writable binary**: turn on and off are buttons, the flame height and the fan selects.
- **The turn off**: never behind the option, a read, a command, a pause or a missing configuration; it
  aborts what holds the line; kept in /data (200 ms at most for the save) with the serial of its
  fireplace, follows the configured address; let go only by a read of that serial showing it off or a
  newer turn on from Gladys, never by time. A 403 is a challenge expired: "key refused" only on proof.
- **Turn on, flame height, fan, setpoint**: behind `allow_control`, decided on a fresh read, checked
  again in `beforeSend`; a turn on (and a setpoint) always sets the timer, or the fireplace is turned
  off; the session is watched by the reads (in /data, never lifted by time).
- **/data**: opened non-blocking, regular files only, every wait bounded.
- **One HTTP exchange at a time** (`src/lane.js`).
- **Clocks**: the monotonic clock for every decision in memory; the wall clock only for /data.
- **Changelog** under `## [Unreleased]`; user-facing texts in English and French; docs in sync.
