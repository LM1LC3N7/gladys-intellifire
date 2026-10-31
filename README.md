# gladys-intellifire

Gladys Assistant external integration for **IntelliFire** gas fireplaces (Hearth & Home Technologies)
over the local API of their IFT Wi-Fi module: flame, pilot, glass hot, room temperature, thermostat,
timer, light level, faults. **Turn off** is never held back by the option, a read or a command (it needs the key); **turn on**, flame height, fan speed and
the thermostat setpoint are off until allowed in the configuration, and every turn on from Gladys sets
a timer. The key that signs the commands is typed, or retrieved once from the IntelliFire cloud by a
button.

Unofficial: not affiliated with Hearth & Home Technologies. Never tested with a real device (built on a
fake module following [intellifire4py](https://github.com/jeeftor/intellifire4py)).

- User guide: [English](docs/en.md), [français](docs/fr.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)
- Notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
```

Apache-2.0.
