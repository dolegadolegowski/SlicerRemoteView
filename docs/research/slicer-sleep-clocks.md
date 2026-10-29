# Clocks across a sleep (SLC-41)

Why `RelayTransport` dates a lost connection the way it does (`Disconnected.lost_at`, `loss_time`, `MAX_SILENCE_S`),
and what that means on each platform. Checked on 2026-10-28.

## What Python's `time.monotonic()` does during a sleep

Slicer 5.12.4 ships Python 3.12.10 (`docs/research/slicer.md`). CPython 3.12's `py_get_monotonic_clock`
([`Python/pytime.c` at v3.12.10](https://github.com/python/cpython/blob/v3.12.10/Python/pytime.c)) reads:

| Platform | Clock | During a sleep | Source |
|---|---|---|---|
| Linux | `clock_gettime(CLOCK_MONOTONIC)` (also `time.get_clock_info("monotonic")` in the sandbox) | stops | glibc `bits/time.h`: `CLOCK_BOOTTIME` is the "monotonic system-wide clock that includes time spent in suspension"; [PEP 418](https://github.com/python/peps/blob/main/peps/pep-0418.rst): "CLOCK_MONOTONIC stops while the machine is suspended" |
| macOS | `mach_absolute_time()` | stops | Apple, [mach_absolute_time](https://developer.apple.com/documentation/kernel/1462446-mach_absolute_time): "this clock does not increment while the system is asleep" (`mach_continuous_time` is the one that counts sleep; XNU [`mach_time.h`](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/mach_time.h): "like mach_absolute_time, but advances during sleep"). PEP 418 (2012) said otherwise for Intel CPUs; Apple's current documentation wins. |
| Windows | `GetTickCount64()` | runs on | Microsoft, [Interrupt Time](https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/SysInfo/interrupt-time.md): "To retrieve elapsed time that accounts for sleep or hibernation, use the GetTickCount or GetTickCount64 function"; PEP 418: "The elapsed time retrieved by GetTickCount() or GetTickCount64() includes time the system spends in sleep or hibernation" |

`time.time()` (the wall clock) runs on through a sleep everywhere; it can also be stepped (NTP, the user).

CPython 3.13 moved Windows' `time.monotonic()` to `QueryPerformanceCounter` (`Python/pytime.c` at v3.13.0); whether
that runs on through a sleep is [TODO verify]. Re-check this table when Slicer moves past Python 3.12.

## Consequences for the transport and the panel

- The transport's heartbeat runs on the event loop's clock, i.e. `time.monotonic()`. Where that clock stops, a sleep
  that begins while Live is noticed only after the wake: the next ping draws a reset or misses its pong (typically
  within 25 s; longer with an upload in flight).
- `loss_time` subtracts the wall-clock time the monotonic clock did not see since the connection's last frame. Where
  the clock stops, that is the sleep: the loss is dated a few seconds after the sleep began, and any sleep that
  outlasts the reconnect window ends the session once the drop is reported.
- Where the clock runs on (Windows), nothing is subtracted; the cap — no later than `MAX_SILENCE_S` (205 s since SLC-40,
  ≈ 212 s before) after the last frame, the longest a connection the heartbeat keeps can stay silent — dates only a
  sleep longer than that. With the default grace (120 s, window 180 s) a sleep of roughly 3 to 6.5 minutes therefore
  still resumes at the wake, and a relay that has ended the session answers `SESSION_NOT_FOUND` (the publisher token
  goes to the relay that issued it, over TLS; nothing else is sent). With a longer grace the band moves up with the
  window.
- A frame that reached the socket before the sleep but is read after the wake counts as a sign of life at the wake.
- A forward wall-clock step between the last frame and the drop reads as a sleep and dates the loss earlier: the
  session can then end at once with no "the relay still holds it" text while the relay holds it for up to its grace
  plus 60 s.
- A transport thread that cannot run (a starved event loop) is dated by the same cap.

## Not done (ideas for later)

- Windows: measure the time asleep with `QueryUnbiasedInterruptTime` (it excludes sleep, per the Interrupt Time page),
  or let the worker loop note a gap in its own ticks (a frozen loop for more than the relay's 60 s of tolerated
  silence, §9.1, means the relay dropped the socket within 60 s of the freeze) and date the loss there.
- Linux: `time.CLOCK_BOOTTIME` minus `CLOCK_MONOTONIC` gives the time spent asleep without reading the wall clock, so
  a wall-clock step could not move the date.
