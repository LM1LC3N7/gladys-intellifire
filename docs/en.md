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
   erase the password. You may also type the key and the user id yourself: if the fireplace is already
   in Home Assistant (IntelliFire integration), they are the `api_key` and `user_id` values of its
   config entry. Neither the local API of the fireplace nor its discovery gives the key.

The password, the key and the user id are kept by Gladys in its database, never shown again, never
written to the logs nor to /data. The password goes to iftapi.net only, and only on the click; the user
id goes to the fireplace only; the key never leaves Gladys (it signs the commands). The reads of the
local API need no password: keep the fireplace on a trusted network.

## Reads

The fireplace is read every 15 s by default (10 to 600 s), not more often, even after a restart (the
time of the last read is kept in /data), and 5 s and 20 s after each command. One request at a time to
the module. A value missing or unreadable is not published (never as 0); nothing older than 2 minutes is
sent as new. When /data cannot be read, the time of the last read is unknown: the fireplace is read
once at the start (one local request per start, even in a restart loop).

## Turn off

The **Turn off** button sends the turn off (power 0), then sets the thermostat setpoint to 0 (so that no
thermostat lights the flame again). Each post asks the module for a challenge; an HTTP 403 is, as
intellifire4py reads it, a challenge expired: a new challenge is asked, up to 10 times. It does not
depend on the option, on a read first, on a pause asked by the module, on a command in progress (it
interrupts it: a command clicked before it and not sent yet is dropped), nor on a stuck read (it cuts
it). It goes to the address typed, or to the one of the last read kept in /data while the configuration
is not read.

A turn off belongs to its fireplace (serial number): the one of the device whose button was clicked,
never the last fireplace read. Each fireplace has its own turn off kept: up to 4 fireplaces with a turn
off kept at once, a click on the turn off of another device never lets one go. Beyond 4, the oldest turn
off of a fireplace that is neither the one clicked nor the one read at the address is let go (written in
the logs). When you type a new address, the turn offs kept follow it. When the last read of the
address shows another IntelliFire (also when a check then reads no serial number), nothing is posted to it; when another one
answers there before it is read, the posts go to the address, it refuses them (403) and that refusal
never counts against the key. In both cases its reads never let the turn off go, the status says so,
and the turn off leaves once this fireplace is read at the address again.

A turn off is signed only with the key of its own fireplace. As far as Gladys knows it in this run, the
key typed belongs to the fireplace that accepted a post signed with it, or to the one it was retrieved
for with "Retrieve the key" (kept in memory only, never in /data, forgotten when another key is saved).
The turn off of another fireplace is then never signed with it. As long as Gladys does not know (after a
restart, before any post accepted), the turn off goes with the key typed.

The turn off cannot leave, and is **kept** (in /data) until it does, in exactly these cases:

- no address known (neither typed nor kept): refused, nothing kept;
- no valid key or user id: it leaves as soon as they are saved (button or typed);
- the fireplace refuses the key or the user id, on proof only (10 challenges refused with 403 in one
  post, the serial number of this fireplace read at the address, a key it never accepted and not known
  to belong to another fireplace): it is no longer tried by itself; it leaves as soon as the key is
  saved (the same one too), on a success of the "Test the connection" button, or on a new click. That
  refusal is this fireplace's only: the turn off and the commands of another fireplace are never held
  by it. 403s when time runs out, or with a key this fireplace already accepted, are never a refusal:
  it is tried again;
- the key typed is known to belong to another fireplace (see above): nothing posted; it leaves once a
  key is saved that is not known to belong to another one;
- another fireplace (another serial number) was read at the address: nothing posted, it waits for its own;
- after a restart, it waits for the configuration to be read (the key is a secret, never in /data);
- the module does not answer: tried every 250 ms for 3 s, then every 15 s (it leaves within 15 s of the
  return of the module); a module answering only 403: every 15 s four times, then spaced up to 1 h;
- the integration is stopping (Gladys asked it to stop): nothing sent; it is kept in /data and leaves
  at the next start.

A turn off is confirmed only by a read showing the flame off and the thermostat off. Otherwise it is
read every 15 s and sent again while the flame is on, 3 times at most; then it is held (said in the
status) without new posts until a new click. It is let go by a read of its fireplace showing it off
(two reads in a row when it never left), or by a turn on of that fireplace clicked afterwards in Gladys
with the option; never by time, nor by the turn off or the turn on of another fireplace (but beyond 4
fireplaces, as said above).

## Turn on, flame, fan, setpoint

Off by default. With the option, each command first reads the fireplace (a fresh read, never the state
in memory) and checks the option again right before each post. **Turn on** sends the flame, then at
once a **timer** (60 min by default, 10 to 180): the fireplace turns itself off at its end. If the timer
cannot be set, Gladys turns the fireplace off at once (the answer says whether that turn off left).
Then the reads watch the session, with no time limit and across restarts (it is kept in /data): the
timer read (not longer than the session) or the fireplace read off ends it; a fireplace read off then
lit again by hand is never turned off by Gladys. The flame read without that timer 10 s after the post:
the timer is sent a second time, then, still missing, Gladys turns the fireplace off.

The **setpoint** puts the fireplace in thermostat mode, which has no 9 h safety shutdown (answer of
Hearth & Home in intellifire4py issue 312): Gladys therefore sends the timer of the session first, then
the setpoint, and watches the session as a turn on; at its end (plus 2 min), if the flame or the
thermostat are still read on, Gladys turns the fireplace off. If the setpoint read back is not the one
sent, Gladys sets the setpoint to 0 at once (thermostat off). A timer already running and not longer
than the session is kept (never lengthened): the setpoint is then sent alone and the session ends with
that timer; a longer timer, or none, is replaced by the timer of the session. To check on a real fireplace: whether the end of the timer stops the thermostat mode.

A command is refused, nothing sent, when:

- the option is off, or the configuration not read yet;
- the integration is stopping (Gladys asked it to stop);
- the key or the user id is missing, or this fireplace refused them (on proof, see above; lifted by a
  save of the key or a success of "Test the connection"), or the key typed is known to belong to
  another fireplace (see above);
- another command is running, a turn off is being sent, or (except for Turn on) a turn off of this
  fireplace is kept;
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

The configuration screen tells the state of the fireplace, each turn off kept or held (named by the
last 4 digits of the serial number of its fireplace when there are several, or when it is not the
fireplace read), a key refused or missing, a module unreachable (next try), a pause asked by the module.
