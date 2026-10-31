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
- "Retrieve the key" button: one sign-in to the IntelliFire cloud per click, key and user id saved in the
  configuration.
