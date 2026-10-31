# IntelliFire

Gladys integration for **IntelliFire** gas fireplaces (Hearth & Home Technologies: Heat & Glo,
Heatilator, Majestic, Monessen, Quadra-Fire) with the IFT Wi-Fi module, through the **local API** of that
module. Never tested with a real fireplace: built and tested against a fake module following the
intellifire4py library (the one of Home Assistant). Not affiliated with Hearth & Home Technologies.

> A gas flame lit from afar is a hazard. Only allow turning on from Gladys when nothing lies near the
> fireplace and nobody can be surprised by the flame.

## What you get

One device per fireplace, identified by its serial number (never by its IP address):

- status (text), flame on, continuous pilot, glass hot, room temperature (°C, as the module gives it),
  thermostat mode, thermostat setpoint, timer left (min), light level (0 to 3, read only), fault
  reported and the list of faults;
- **Turn off** (button), never behind the option;
- **Turn on** (button), **Flame height** (1 to 5), **Fan speed** (off, 1 to 4) and **Thermostat
  setpoint** (whole °C): off until the option "Allow turning on, the flame, the fan and the setpoint"
  is ticked.

None of these settings is a switch: a "turn everything off" (voice assistant, scene) never reaches the
flame.

## Setup

1. Give the Wi-Fi module of the fireplace a fixed address in your router.
2. Enter that address, save: the fireplace is read, the device shows in the Discovery tab.
3. The commands (turning off included) need the **key** of the fireplace and the **user id** of your
   IntelliFire account: enter the e-mail address and password of the account, save, then click
   **Retrieve the key**. Gladys signs in once to the IntelliFire cloud (iftapi.net, over HTTPS), takes
   the key of the fireplace whose serial number was read at the address and saves it. You may then
   erase the password. You may also type the key and the user id yourself.

The password, the key and the user id are kept by Gladys in its database, never shown again, never
written to the logs nor to /data. The password goes to iftapi.net only, and only on the click; the user
id goes to the fireplace only; the key never leaves Gladys (it signs the commands). The reads of the
local API need no password: keep the fireplace on a trusted network.

## Reads

The fireplace is read every 15 s by default (10 to 600 s), not more often, even after a restart (the
time of the last read is kept in /data), and 5 s and 20 s after each command. One request at a time to
the module. A value missing or unreadable is not published (never as 0); nothing older than 2 minutes is
sent as new.

## Turn off

The **Turn off** button sends the turn off (power 0), then sets the thermostat setpoint to 0 (so that no
thermostat lights the flame again). It does not depend on the option, on a read first, on a pause asked
by the module, on a command in progress (it interrupts it: a command clicked before it and not sent yet
is dropped), nor on a stuck read (it cuts it). It goes to the address typed, or to the one of the last
read kept in /data while the configuration is not read.

The turn off cannot leave, and is **kept** (in /data) until it does, in exactly these cases:

- no address known (neither typed nor kept): refused, nothing kept;
- no valid key or user id: it leaves as soon as they are saved (button or typed);
- the fireplace refuses the key or the user id (HTTP 403, twice with a new challenge): it is no longer
  tried by itself; it leaves as soon as a new key is saved, on a successful read by the "Test the
  connection" button, or on a new click;
- after a restart, it waits for the configuration to be read (the key is a secret, never in /data);
- the module does not answer: tried every 250 ms for 3 s, then every 15 s.

A turn off is confirmed only by a read showing the flame off and the thermostat off. Otherwise it is
read every 15 s and sent again while the flame is on, 3 times at most; then it is held (said in the
status) without new posts until a new click. It is let go by a read showing the fireplace off (two
reads in a row when it never left), or by a turn on clicked afterwards in Gladys with the option; never
by time.

## Turn on, flame, fan, setpoint

Off by default. With the option, each command first reads the fireplace (a fresh read, never the state
in memory) and checks the option again right before each post. **Turn on** sends the flame, then at
once a **timer** (60 min by default, 10 to 180): the fireplace turns itself off at its end. If the timer
cannot be set, Gladys turns the fireplace off at once; if the reads of the next two minutes show the
flame without that timer, Gladys turns it off too.

A command is refused, nothing sent, when:

- the option is off, or the configuration not read yet;
- the key or the user id is missing, or the fireplace refused them;
- another command is running, a turn off is being sent, or (except for Turn on) a turn off is kept;
- the module asked to wait (HTTP 429 or 503);
- the fresh read fails or does not come in time (the command must leave within 3.5 s);
- the fireplace read is not this device (another serial number);
- a value needed is missing from the read;
- Turn on: a fault that disables the fireplace is listed (pilot, flame, appliance disabled, lock-out,
  offline, ECM offline, or an unknown code), or /data cannot be written;
- Flame height and Setpoint: the fireplace is off (Gladys does not send them to a fireplace off);
- Fan: the fireplace has no fan; Setpoint: it has no thermostat;
- the value is out of bounds: height 1 to 5, fan 0 to 4, setpoint from 5 °C to the "Highest setpoint"
  (26 °C by default, 37 °C at most, the limit of the API).

A command succeeds only when the read back shows the value asked; otherwise Gladys answers "sent, not
applied yet", "sent, without confirmation" or "nothing sent", as it happened.

## Status

The configuration screen tells the state of the fireplace, a turn off kept or held, a key refused or
missing, a module unreachable (next try), a pause asked by the module.
