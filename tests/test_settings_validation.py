"""A bad configuration must stop the app at startup with a message that says what to fix.

Each case starts a real ``manage.py check`` in a subprocess, because settings are read at import time.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def run_check(**env) -> subprocess.CompletedProcess:
    full = {**os.environ, "DATABASE_URL": "postgres://u:p@localhost:5432/x", "REDIS_URL": "redis://localhost:6379/0"}
    full.update(env)
    return subprocess.run([sys.executable, "manage.py", "check"], cwd=ROOT, env=full,
                          capture_output=True, text=True, timeout=60)


def test_a_valid_configuration_starts():
    result = run_check(DJANGO_DEBUG="true")
    assert result.returncode == 0, result.stderr


def test_production_mode_with_a_proper_secret_key_starts():
    assert run_check(DJANGO_DEBUG="false", DJANGO_SECRET_KEY="k" * 40).returncode == 0


@pytest.mark.parametrize("env,expected", [
    ({"DATABASE_URL": ""}, "DATABASE_URL"),
    ({"REDIS_URL": ""}, "REDIS_URL"),
    ({"DJANGO_DEBUG": "false", "DJANGO_SECRET_KEY": "change-me-in-production"}, "DJANGO_SECRET_KEY"),
    ({"DJANGO_DEBUG": "false", "DJANGO_SECRET_KEY": "short"}, "DJANGO_SECRET_KEY"),
    ({"DJANGO_DEBUG": "maybe"}, "DJANGO_DEBUG must be true or false"),
    ({"RATE_LIMIT_LOGIN": "lots"}, "RATE_LIMIT_LOGIN"),
    ({"RATE_LIMIT_DOSE_LINK": "10/fortnight"}, "RATE_LIMIT_DOSE_LINK"),
    ({"LOG_FORMAT": "xml"}, "LOG_FORMAT"),
    ({"WEEKLY_SUMMARY_LOCAL_HOUR": "30"}, "WEEKLY_SUMMARY_LOCAL_HOUR"),
    ({"REMINDER_GRACE_MINUTES": "200", "DOSE_MISSED_AFTER_MINUTES": "120"}, "REMINDER_GRACE_MINUTES"),
    ({"REMINDER_SENDING_TIMEOUT_SECONDS": "30"}, "REMINDER_SENDING_TIMEOUT_SECONDS"),
    ({"EMAIL_PORT": "smtp"}, "EMAIL_PORT"),
    ({"EMAIL_USE_TLS": "sometimes"}, "EMAIL_USE_TLS"),
])
def test_bad_settings_stop_startup_with_a_clear_message(env, expected):
    result = run_check(**env)
    assert result.returncode != 0
    assert expected in result.stderr
