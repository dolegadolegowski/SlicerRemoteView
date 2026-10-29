"""Long work in steps (SLC-28): the scene's preparation runs a slice at a time, so Slicer keeps drawing and handling
input while a large scene is collected and decimated.

A *steps* generator is written like a function that ``yield``\\ s between its heavy calls and ``return``\\ s its result;
``yield from`` nests them. :func:`run` takes one to the end in a single call — the one-shot functions
(``collect_scene``, ``decimate_entity``, ``build_snapshot``) are that, so the one-shot and the stepwise paths run the
same code and give the same bytes — and :class:`Stepper` takes one a slice of time at a time (the panel: one slice per
pump tick). A step is one numpy or VTK call, or a few short ones, which cannot be split: a slice ends after the step
that crosses it. Why steps on the main thread and not a worker thread: ``docs/research/slicer-prepare.md``.

Pure Python. Main thread only, like the work it runs.
"""

from __future__ import annotations

import contextlib
from collections.abc import Callable, Generator
from dataclasses import dataclass

#: A generator that yields ``None`` between steps and returns its result.
type Steps[T] = Generator[None, None, T]


def run[T](steps: Steps[T]) -> T:
    """``steps`` taken to the end in this call; their result."""
    while True:
        try:
            next(steps)
        except StopIteration as stop:
            return stop.value


@dataclass
class Progress:
    """How far a preparation is, in units of work (a node collected, a node fitted); for the panel."""

    done: int = 0
    total: int = 0


class Stepper[T]:
    """``steps`` taken a slice at a time (see the module docstring). An exception from a step leaves :meth:`advance`
    and ends the work (a later :meth:`advance` raises ``RuntimeError``: the work has no result); :meth:`close`
    abandons it (nothing after the step it is at runs), also from inside a step that calls back into its owner: the
    generator is then closed as soon as that step returns."""

    def __init__(self, steps: Steps[T], clock: Callable[[], float]) -> None:
        self._steps = steps
        self._clock = clock
        self._failed = False
        self._closed = False
        self.done = False
        self.result: T | None = None
        #: the steps taken so far
        self.taken = 0

    def advance(self, seconds: float) -> bool:
        """Take steps until ``seconds`` have passed on the clock (at least one step); whether the work is done (its
        value is then :attr:`result`)."""
        if self._failed:
            raise RuntimeError("the work failed in an earlier step")
        start = self._clock()
        while not self.done and not self._closed:
            try:
                next(self._steps)
            except StopIteration as stop:
                self.done, self.result = True, stop.value
                break
            except BaseException:
                self._failed = True
                raise
            self.taken += 1
            if self._closed:  # closed by the step itself (it called back): nothing after it runs
                self._steps.close()
                break
            if self._clock() - start >= seconds:
                break
        return self.done

    def close(self) -> None:
        self._closed = True
        with contextlib.suppress(ValueError):  # running: closed when the step returns
            self._steps.close()
