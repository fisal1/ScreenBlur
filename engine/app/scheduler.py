"""Latest-frame scheduler.

The engine runs at most one inference at a time. While it is busy, a single
replaceable "pending" slot holds the newest frame that arrived. Older pending
frames are dropped, which keeps end-to-end latency bounded when capture
outpaces inference.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from .protocol import Frame

logger = logging.getLogger(__name__)

FrameHandler = Callable[["Frame", "FrameJob"], Awaitable[None]]


@dataclass(slots=True)
class SchedulerStats:
    """Consistent scheduler counters for diagnostics and tests."""

    submitted: int = 0
    processed: int = 0
    dropped: int = 0
    errors: int = 0
    superseded: int = 0
    pending: bool = False
    active_seq: int | None = None
    last_seq: int | None = None

    @property
    def dropped_frames(self) -> int:
        """Protocol-facing alias for ``dropped``."""
        return self.dropped

    def to_dict(self) -> dict[str, int | bool | None]:
        return {
            "submitted": self.submitted,
            "processed": self.processed,
            "dropped": self.dropped,
            "errors": self.errors,
            "superseded": self.superseded,
            "pending": self.pending,
            "active_seq": self.active_seq,
            "last_seq": self.last_seq,
        }


class FrameJob:
    """A running frame plus a race-free view of whether it is stale.

    ``superseded`` must be read by the handler right before emitting a result.
    Because the worker does not consume the pending slot until the handler
    returns, the property is stable across awaits inside the handler.
    """

    __slots__ = ("_scheduler", "frame")

    def __init__(self, scheduler: LatestFrameScheduler, frame: Frame) -> None:
        self._scheduler = scheduler
        self.frame = frame

    @property
    def superseded(self) -> bool:
        pending = self._scheduler._pending
        return pending is not None and pending.frame.seq > self.frame.seq


class LatestFrameScheduler:
    """Single-worker, latest-only async frame scheduler."""

    def __init__(self, handler: FrameHandler, *, name: str = "screenblur-frame-worker") -> None:
        self._handler = handler
        self._name = name
        self._pending: FrameJob | None = None
        self._active: FrameJob | None = None
        self._task: asyncio.Task[None] | None = None
        self._wakeup = asyncio.Event()
        self._idle = asyncio.Event()
        self._idle.set()
        self._stopping = False
        self._stats = SchedulerStats()

    # ------------------------------------------------------------------ API

    async def start(self) -> None:
        """Start the worker task (idempotent)."""
        if self._stopping:
            raise RuntimeError("scheduler is stopping")
        self._ensure_worker()

    def submit(self, frame: Frame) -> bool:
        """Submit a frame, replacing any waiting older frame.

        Returns ``False`` once the scheduler has been stopped. Must be called
        from the scheduler's event loop.
        """
        if self._stopping:
            return False
        self._ensure_worker()
        if self._pending is not None:
            self._stats.dropped += 1
        self._pending = FrameJob(self, frame)
        self._stats.submitted += 1
        self._idle.clear()
        self._wakeup.set()
        return True

    def latest(self) -> Frame | None:
        """Newest frame that is still pending or actively being processed."""
        if self._pending is not None:
            return self._pending.frame
        if self._active is not None:
            return self._active.frame
        return None

    def drop_pending(self) -> bool:
        """Discard the waiting frame, if any. The active job is not cancelled."""
        if self._pending is None:
            return False
        self._pending = None
        self._stats.dropped += 1
        if self._active is None:
            self._idle.set()
        return True

    async def wait_idle(self, timeout: float | None = None) -> bool:
        """Wait until neither a pending nor an active frame remains."""
        if self._pending is None and self._active is None:
            return True
        try:
            if timeout is None:
                await self._idle.wait()
            else:
                await asyncio.wait_for(self._idle.wait(), timeout=timeout)
        except TimeoutError:
            return False
        return True

    async def stop(self, *, timeout: float | None = 5.0) -> None:
        """Stop accepting frames and let the active handler finish gracefully."""
        self._stopping = True
        self.drop_pending()
        self._wakeup.set()
        task = self._task
        if task is None:
            self._idle.set()
            return
        try:
            if timeout is None:
                await task
            else:
                await asyncio.wait_for(task, timeout=timeout)
        except TimeoutError:
            logger.warning("frame worker did not stop within %.1fs; cancelling", timeout)
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        except asyncio.CancelledError:
            task.cancel()
            raise
        finally:
            if self._task is task:
                self._task = None
            self._idle.set()

    def stats(self) -> SchedulerStats:
        """Return a snapshot of the current counters and job state."""
        return SchedulerStats(
            submitted=self._stats.submitted,
            processed=self._stats.processed,
            dropped=self._stats.dropped,
            errors=self._stats.errors,
            superseded=self._stats.superseded,
            pending=self._pending is not None,
            active_seq=self._active.frame.seq if self._active is not None else None,
            last_seq=self._stats.last_seq,
        )

    # -------------------------------------------------------------- internals

    def _ensure_worker(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(
                self._run(),
                name=self._name,
            )

    async def _run(self) -> None:
        try:
            while True:
                if self._stopping and self._pending is None:
                    break
                if self._pending is None:
                    self._idle.set()
                    await self._wakeup.wait()
                    self._wakeup.clear()
                    continue

                job = self._pending
                self._pending = None
                self._active = job
                self._idle.clear()
                frame = job.frame

                try:
                    await self._handler(frame, job)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self._stats.errors += 1
                    # Never include frame content (or a token) in logs.
                    logger.exception("frame handler failed for seq=%s", frame.seq)
                else:
                    self._stats.processed += 1
                    self._stats.last_seq = frame.seq
                finally:
                    self._active = None
                    if self._pending is not None:
                        self._stats.superseded += 1
                    if self._pending is None:
                        self._idle.set()
        finally:
            self._idle.set()
