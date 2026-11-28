"""Regression tests for the CI failure "RuntimeError: Never call result.get() within a task!" on Python 3.12.

Cause: Celery keeps its "do not wait for a result inside a task" guard in one process-wide boolean that its own
context manager saves and restores without a lock. Tests that launch eager tasks from several threads at once could
leave it stuck on True, and the next `.get()` anywhere (test_ping_task_runs_eagerly, test_same_delivery_task...)
failed. conftest.py replaces the context manager with a counting, locked one. These tests pin that behaviour down
deterministically (no timing luck), so the problem cannot come back unnoticed.
"""
import threading

import celery.result as celery_result
import pytest
from celery import shared_task
from celery._state import _set_task_join_will_block, task_join_will_block

import conftest
from notifications.tasks import ping


def overlap(guard):
    """Thread A enters the guard, thread B enters while A is inside, A leaves, then B leaves.

    Returns what B saw of the flag while it was still inside the guard after A had left.
    """
    a_inside, b_inside, a_left = threading.Event(), threading.Event(), threading.Event()
    seen_by_b = []

    def thread_a():
        with guard():
            a_inside.set()
            assert b_inside.wait(timeout=10)
        a_left.set()

    def thread_b():
        assert a_inside.wait(timeout=10)
        with guard():
            b_inside.set()
            assert a_left.wait(timeout=10)
            seen_by_b.append(task_join_will_block())

    threads = [threading.Thread(target=thread_a), threading.Thread(target=thread_b)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not any(t.is_alive() for t in threads)
    return seen_by_b


def test_overlapping_guards_leave_the_flag_clear():
    overlap(celery_result.denied_join_result)  # the installed, thread-safe version
    assert task_join_will_block() is False


def test_the_guard_stays_raised_until_the_last_overlapping_task_has_finished():
    """Not only 'never stuck': it must not drop while a task is still running (that would let a .get() slip through)."""
    assert overlap(celery_result.denied_join_result) == [True]


def test_celerys_own_guard_really_can_stick_which_is_why_conftest_replaces_it():
    """If this fails, Celery fixed the race itself: delete the replacement in conftest.py and this test."""
    try:
        overlap(conftest.CELERY_DENIED_JOIN_RESULT)
        assert task_join_will_block() is True
    finally:
        _set_task_join_will_block(False)


def test_the_replacement_is_installed_where_celery_looks_it_up():
    import celery.app.task as celery_task

    assert celery_result.denied_join_result is conftest.thread_safe_denied_join_result
    assert celery_task.denied_join_result is conftest.thread_safe_denied_join_result


def test_eager_tasks_launched_from_many_threads_never_leave_the_flag_raised():
    failures = []

    def launch():
        try:
            for _ in range(40):
                assert ping.delay().result == "pong"  # .delay() is what raises the guard in eager mode
        except Exception as exc:  # surfaced in the main thread
            failures.append(exc)

    barrier_threads = [threading.Thread(target=launch) for _ in range(8)]
    for t in barrier_threads:
        t.start()
    for t in barrier_threads:
        t.join(timeout=60)
    assert not failures, failures
    assert task_join_will_block() is False
    assert conftest._guard["holders"] == 0


def test_the_guard_is_released_even_when_the_task_raises():
    with pytest.raises(ValueError):
        with celery_result.denied_join_result():
            assert task_join_will_block() is True
            raise ValueError("boom")
    assert task_join_will_block() is False
    assert conftest._guard["holders"] == 0


def test_the_guard_restores_the_value_it_found_not_always_false():
    _set_task_join_will_block(True)  # e.g. inside a real worker process
    try:
        with celery_result.denied_join_result():
            assert task_join_will_block() is True
        assert task_join_will_block() is True
    finally:
        _set_task_join_will_block(False)


@shared_task
def _task_that_waits_for_another_task():
    return ping.apply().get()  # exactly what Celery forbids inside a task


def test_a_task_still_cannot_wait_on_another_tasks_result():
    """The protection the guard exists for still works: the replacement did not just switch it off."""
    with pytest.raises(RuntimeError, match=r"Never call result\.get\(\) within a task"):
        _task_that_waits_for_another_task.delay()
    assert task_join_will_block() is False


def test_the_flag_is_clear_at_the_start_of_every_test():
    assert task_join_will_block() is False
