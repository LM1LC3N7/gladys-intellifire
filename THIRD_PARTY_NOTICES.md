# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## intellifire4py

The local API of the IntelliFire Wi-Fi module (`/poll`, `/get_challenge`,
`/post`), the fields of a poll and their units, the commands and their
ranges, the signature of a command, the error codes and the calls of the
IntelliFire cloud (iftapi.net) used to retrieve the key come from
**intellifire4py** 4.5.6 (<https://github.com/jeeftor/intellifire4py>, commit
`3425474` of 2026-10-12, MIT, Jeff Stein), the library of the IntelliFire
integration of Home Assistant. This integration ports parts of its logic to
JavaScript; no Python code runs here and that library is not a dependency.
This port was modified: written in JavaScript, every request bounded in time
and size, one request at a time, a turn off that is never held back, a timer
set at every turn on, commands behind an option, its own User-Agent for the
cloud, no UDP discovery, no cloud polling nor cloud commands.

Two anonymized fixtures of its test suite (`tests/fixtures/local_poll.json`,
`tests/fixtures/error_6_642.json`) are copied as is into
`test/fixtures/reference/` (tests only, not in the image).

```
MIT License

Copyright © 2021 Jeff Stein

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## gladys-testkit

`test/kit/` (tests only, not in the image) is copied from gladys-testkit
(Apache-2.0, same author as this integration).
