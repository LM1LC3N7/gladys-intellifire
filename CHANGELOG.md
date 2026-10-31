# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- IntelliFire gas fireplaces over the local API of the IFT Wi-Fi module: flame, pilot, glass hot,
  room temperature, thermostat mode and setpoint, timer left, light level, faults.
- Turn off (power 0, then thermostat setpoint 0), never held back; kept in /data until it leaves and is
  seen applied.
- Turn on (with a timer always set), flame height, fan speed and thermostat setpoint, behind an option
  off by default, decided on a fresh read, bounded.
- A setpoint always posts the timer of the session first; the session of a turn on or a setpoint is
  watched until its timer or the fire off is read, across restarts.
- A 403 is a challenge expired, retried with new challenges; a key is "refused" only on proof.
- A turn off kept follows its fireplace (serial) to a new address; another fireplace never lets it go.
- A turn off belongs to the device clicked; a setpoint never lengthens a shorter timer; the app stops
  every request and timer at shutdown.
- "Retrieve the key" button: one sign-in to the IntelliFire cloud per click, key and user id saved in the
  configuration.
