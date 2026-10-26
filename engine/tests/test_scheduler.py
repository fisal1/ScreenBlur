from __future__ import annotations

import asyncio

from app.protocol import Frame
from app.scheduler import LatestFrameScheduler


def _frame(seq: int) -> Frame:
    return Frame(payload=b"\xff\xd8x\xff\xd9", seq=seq, display_id=1, ts=0)


def test_latest_only_replaces_pending() -> None:
    async def scenario() -> None:
        processed: list[int] = []
        superseded_flags: list[bool] = []
        started = asyncio.Event()
        release = asyncio.Event()

        async def handler(frame: Frame, job) -> None:
            processed.append(frame.seq)
            started.set()
            await release.wait()
            superseded_flags.append(job.superseded)

        scheduler = LatestFrameScheduler(handler)
        assert scheduler.submit(_frame(1))
        await asyncio.wait_for(started.wait(), timeout=1.0)

        assert scheduler.submit(_frame(2))
        assert scheduler.submit(_frame(3))

        midway = scheduler.stats()
        assert midway.active_seq == 1
        assert midway.pending is True
        assert midway.dropped == 1
        assert scheduler.latest() is not None
        assert scheduler.latest().seq == 3

        release.set()
        assert await scheduler.wait_idle(timeout=2.0)

        assert processed == [1, 3]
        assert superseded_flags == [True, False]
        stats = scheduler.stats()
        assert stats.processed == 2
        assert stats.dropped == 1
        assert stats.superseded == 1
        assert stats.last_seq == 3
        assert stats.pending is False
        await scheduler.stop()

    asyncio.run(scenario())


def test_stop_drops_pending_and_rejects_new_frames() -> None:
    async def scenario() -> None:
        started = asyncio.Event()
        blocker = asyncio.Event()

        async def handler(frame: Frame, job) -> None:
            started.set()
            await blocker.wait()

        scheduler = LatestFrameScheduler(handler)
        scheduler.submit(_frame(1))
        await asyncio.wait_for(started.wait(), timeout=1.0)
        scheduler.submit(_frame(2))

        await scheduler.stop(timeout=0.05)
        stats = scheduler.stats()
        assert stats.dropped == 1
        assert stats.pending is False
        assert scheduler.submit(_frame(3)) is False

    asyncio.run(scenario())


def test_handler_errors_do_not_stop_worker() -> None:
    async def scenario() -> None:
        processed: list[int] = []
        started = asyncio.Event()

        async def handler(frame: Frame, job) -> None:
            processed.append(frame.seq)
            started.set()
            if frame.seq == 1:
                raise RuntimeError("boom")

        scheduler = LatestFrameScheduler(handler)
        scheduler.submit(_frame(1))
        await asyncio.wait_for(started.wait(), timeout=1.0)
        scheduler.submit(_frame(2))

        assert await scheduler.wait_idle(timeout=2.0)
        stats = scheduler.stats()
        assert processed == [1, 2]
        assert stats.errors == 1
        assert stats.processed == 1
        assert stats.last_seq == 2
        await scheduler.stop()

    asyncio.run(scenario())


def test_stop_is_idempotent_and_waits_for_active_job() -> None:
    async def scenario() -> None:
        started = asyncio.Event()

        async def handler(frame: Frame, job) -> None:
            started.set()
            await asyncio.sleep(0.01)

        scheduler = LatestFrameScheduler(handler)
        scheduler.submit(_frame(1))
        await asyncio.wait_for(started.wait(), timeout=1.0)
        await scheduler.stop(timeout=2.0)
        await scheduler.stop(timeout=2.0)
        assert scheduler.stats().processed == 1

    asyncio.run(scenario())


def test_submit_after_stop_returns_false() -> None:
    async def scenario() -> None:
        async def handler(frame: Frame, job) -> None:
            return None

        scheduler = LatestFrameScheduler(handler)
        await scheduler.start()
        await scheduler.stop()
        assert scheduler.submit(_frame(1)) is False

    asyncio.run(scenario())


def test_wait_idle_times_out_while_handler_is_blocked() -> None:
    async def scenario() -> None:
        started = asyncio.Event()
        blocker = asyncio.Event()

        async def handler(frame: Frame, job) -> None:
            started.set()
            await blocker.wait()

        scheduler = LatestFrameScheduler(handler)
        scheduler.submit(_frame(1))
        await asyncio.wait_for(started.wait(), timeout=1.0)
        assert await scheduler.wait_idle(timeout=0.01) is False
        blocker.set()
        assert await scheduler.wait_idle(timeout=1.0) is True
        await scheduler.stop()

    asyncio.run(scenario())
