import logging
from datetime import timedelta

import pytest
from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured
from django.utils import timezone
from redis.exceptions import ConnectionError as RedisConnectionError
from rest_framework.settings import api_settings
from rest_framework.test import APIClient

from config.env import validate_rate
from config.ratelimit import ConfiguredThrottle
from conftest import PASSWORD, client_for, make_dose, make_user
from scheduling import links

pytestmark = pytest.mark.django_db
LOGIN, REGISTER, GRANTS = "/api/auth/login/", "/api/auth/register/", "/api/access/grants/"


def limits(settings, **overrides):
    settings.RATE_LIMITS = {
        "login": "1000/min", "login_account": "1000/min", "register": "1000/min",
        "invite": "1000/min", "dose_link": "1000/min", **overrides,
    }


def attempt(api, email, password="wrong-password", **extra):
    return api.post(LOGIN, {"email": email, "password": password}, format="json", **extra)


# --- login --------------------------------------------------------------------------
def test_login_is_limited_per_client_address(settings, patient):
    limits(settings, login="3/min")
    api = APIClient()
    assert [attempt(api, patient.email).status_code for _ in range(3)] == [401, 401, 401]
    blocked = attempt(api, patient.email)
    assert blocked.status_code == 429 and int(blocked["Retry-After"]) > 0
    assert attempt(api, patient.email, PASSWORD).status_code == 429  # even correct credentials


def test_other_addresses_are_not_affected(settings, patient):
    limits(settings, login="2/min")
    api = APIClient()
    for _ in range(2):
        attempt(api, patient.email)
    assert attempt(api, patient.email).status_code == 429
    assert attempt(api, patient.email, PASSWORD, REMOTE_ADDR="10.9.9.9").status_code == 200


def test_login_is_limited_per_account_across_addresses(settings, patient, other_patient):
    limits(settings, login_account="2/min")
    api = APIClient()
    for i in range(2):
        attempt(api, patient.email, REMOTE_ADDR=f"10.0.0.{i}")
    assert attempt(api, patient.email.upper(), PASSWORD, REMOTE_ADDR="10.0.0.99").status_code == 429
    assert attempt(api, other_patient.email, PASSWORD).status_code == 200  # another account is fine


def test_login_within_limits_still_works(settings, patient):
    limits(settings)
    assert set(attempt(APIClient(), patient.email, PASSWORD).json()) == {"access", "refresh"}


def test_malformed_login_bodies_do_not_break_the_throttle(settings):
    limits(settings, login_account="1/min")
    api = APIClient()
    assert api.post(LOGIN, {"password": "x"}, format="json").status_code == 400
    assert api.post(LOGIN, {"email": 123, "password": "x"}, format="json").status_code in (400, 401)
    assert api.post(LOGIN, "{not json", content_type="application/json").status_code == 400


def test_spoofed_forwarded_for_header_does_not_dodge_the_limit(settings, patient):
    """NUM_PROXIES defaults to 0: only the socket address counts."""
    limits(settings, login="2/min")
    api = APIClient()
    codes = [attempt(api, patient.email, HTTP_X_FORWARDED_FOR=f"1.2.3.{i}").status_code for i in range(3)]
    assert codes == [401, 401, 429]


def test_counters_hold_no_email_addresses(settings, patient):
    limits(settings, login_account="5/min")
    attempt(APIClient(), patient.email)
    keys = [str(k) for k in cache._cache]
    assert any("login_account" in k for k in keys) and not any("@" in k for k in keys)


# --- register / invite --------------------------------------------------------------------
def test_registration_is_limited(settings):
    limits(settings, register="2/hour")
    api = APIClient()
    codes = [
        api.post(REGISTER, {"email": f"new{i}@example.com", "password": PASSWORD, "timezone": "UTC"},
                 format="json").status_code
        for i in range(3)
    ]
    assert codes == [201, 201, 429]


def test_invites_are_limited_per_patient_but_listing_is_not(settings, patient_api, other_api):
    limits(settings, invite="2/hour")
    send = lambda api, n: api.post(GRANTS, {"email": f"x{n}@example.com"}, format="json").status_code  # noqa: E731
    assert [send(patient_api, n) for n in range(3)] == [202, 202, 429]
    assert all(patient_api.get(GRANTS).status_code == 200 for _ in range(5))
    assert send(other_api, 9) == 202  # a different patient has their own allowance


def test_a_rejected_invite_attempt_for_a_non_patient_is_not_counted_against_anyone(settings, caregiver):
    limits(settings, invite="1/hour")
    api = client_for(caregiver)
    assert [api.post(GRANTS, {"email": "a@example.com"}, format="json").status_code for _ in range(3)] == [403] * 3


# --- the one-click link -------------------------------------------------------------------------
def link(dose):
    return links.dose_link(dose).replace("http://localhost:8000", "")


def test_dose_link_is_limited_per_client_address(settings, client, patient):
    limits(settings, dose_link="2/min")
    dose = make_dose(patient, timezone.now(), "reminded")
    assert [client.get(link(dose)).status_code for _ in range(2)] == [200, 200]
    blocked = client.get(link(dose))
    assert blocked.status_code == 429 and int(blocked["Retry-After"]) > 0
    assert "Too many requests" in blocked.content.decode()
    assert client.get(link(dose), REMOTE_ADDR="10.1.1.1").status_code == 200


def test_throttled_post_does_not_change_the_dose(settings, client, patient):
    limits(settings, dose_link="1/min")
    dose = make_dose(patient, timezone.now(), "reminded")
    client.get(link(dose))
    assert client.post(link(dose)).status_code == 429
    dose.refresh_from_db()
    assert dose.status == "reminded"


def test_dose_link_limit_applies_before_the_token_is_checked(settings, client):
    limits(settings, dose_link="1/min")
    assert client.get("/dose/taken/garbage/").status_code == 400
    assert client.get("/dose/taken/garbage/").status_code == 429


# --- failing open and configuration -------------------------------------------------------------
def test_redis_outage_does_not_block_login_and_is_logged(settings, patient, monkeypatch, caplog):
    limits(settings, login="1/min")

    class Broken:
        def get(self, *a, **k):
            raise RedisConnectionError("redis is down")

    monkeypatch.setattr(ConfiguredThrottle, "cache", Broken())
    with caplog.at_level(logging.ERROR, logger="config.ratelimit"):
        assert attempt(APIClient(), patient.email, PASSWORD).status_code == 200
        assert attempt(APIClient(), patient.email, PASSWORD).status_code == 200  # no limit while down
    events = [r for r in caplog.records if getattr(r, "event", "") == "ratelimit.cache_unavailable"]
    assert events and events[0].fields["error_type"] == "ConnectionError"


@pytest.mark.parametrize("rate", ["10/min", "5/hour", "1/day", "100/sec"])
def test_valid_rates_accepted(rate):
    validate_rate("X", rate)


@pytest.mark.parametrize("rate", ["10/fortnight", "ten/min", "10", "/min", "-5/min"])
def test_invalid_rates_rejected(rate):
    with pytest.raises(ImproperlyConfigured):
        validate_rate("X", rate)


def test_defaults_are_sensible_and_drf_sees_our_settings():
    """Guards a real bug: importing DRF while settings load made DRF cache its defaults."""
    from django.conf import settings
    assert settings.RATE_LIMITS["login"] == "10/min" and settings.RATE_LIMITS["login_account"] == "5/min"
    assert api_settings.NUM_PROXIES == 0
    assert [c.__name__ for c in api_settings.DEFAULT_AUTHENTICATION_CLASSES] == ["JWTAuthentication"]
