import re
import time
from datetime import timedelta
from unittest import mock

import pytest
from django.core import signing
from django.db import connection
from django.test import Client
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from conftest import make_dose
from notifications import services as notification_services
from scheduling import links
from scheduling.models import DoseEvent, DoseStatus

pytestmark = pytest.mark.django_db


def link_for(dose):
    return links.dose_link(dose).replace("http://localhost:8000", "")


def state(dose):
    dose.refresh_from_db()
    return dose.status, dose.taken_at, dose.taken_late


def shifted_clock(seconds):
    """Pretend ``seconds`` have passed, for signature age checks."""
    return mock.patch("django.core.signing.time.time", return_value=time.time() + seconds)


# --- GET never changes anything -------------------------------------------------------
def test_get_shows_confirmation_and_changes_nothing(client, patient):
    dose = make_dose(patient, timezone.now(), DoseStatus.REMINDED)
    with CaptureQueriesContext(connection) as queries:
        resp = client.get(link_for(dose))
    assert resp.status_code == 200
    body = resp.content.decode()
    assert "Metformin" in body and "500 mg" in body
    assert '<form method="post">' in body and "Yes, I took it" in body
    assert state(dose) == (DoseStatus.REMINDED, None, False)
    writes = [q["sql"] for q in queries if not q["sql"].lstrip().upper().startswith("SELECT")]
    assert writes == []  # a prefetching mail scanner cannot modify data


def test_head_request_changes_nothing(client, patient):
    dose = make_dose(patient, timezone.now(), DoseStatus.REMINDED)
    assert client.head(link_for(dose)).status_code == 200
    assert state(dose)[0] == DoseStatus.REMINDED


def test_page_is_not_cached_and_leaks_no_referrer(client, patient):
    dose = make_dose(patient, timezone.now())
    resp = client.get(link_for(dose))
    assert resp["Cache-Control"] == "no-store" and resp["Referrer-Policy"] == "no-referrer"


def test_other_methods_not_allowed(client, patient):
    dose = make_dose(patient, timezone.now())
    for method in ("put", "patch", "delete"):
        assert getattr(client, method)(link_for(dose)).status_code == 405
    assert state(dose)[0] == DoseStatus.PENDING


# --- POST does the work --------------------------------------------------------------
def test_post_marks_taken_without_login_or_csrf_token(patient):
    dose = make_dose(patient, timezone.now(), DoseStatus.REMINDED)
    browser = Client(enforce_csrf_checks=True)  # no session, no CSRF cookie
    resp = browser.post(link_for(dose))
    assert resp.status_code == 200 and "Recorded. Thank you." in resp.content.decode()
    status, taken_at, late = state(dose)
    assert (status, late) == (DoseStatus.TAKEN, False) and taken_at is not None


def test_using_the_link_twice_is_safe(client, patient):
    dose = make_dose(patient, timezone.now(), DoseStatus.REMINDED)
    client.post(link_for(dose))
    first = state(dose)
    resp = client.post(link_for(dose))
    assert resp.status_code == 200 and "Already recorded" in resp.content.decode()
    assert state(dose) == first  # taken_at not overwritten
    # ...and the page after use no longer offers the button.
    assert "Yes, I took it" not in client.get(link_for(dose)).content.decode()


def test_missed_dose_via_link_is_taken_late(client, patient):
    dose = make_dose(patient, timezone.now() - timedelta(hours=3), DoseStatus.MISSED)
    assert "still record" in client.get(link_for(dose)).content.decode()
    client.post(link_for(dose))
    status, taken_at, late = state(dose)
    assert (status, late) == (DoseStatus.TAKEN, True) and taken_at is not None


def test_skipped_dose_cannot_be_changed_by_link(client, patient):
    dose = make_dose(patient, timezone.now(), DoseStatus.SKIPPED)
    assert client.post(link_for(dose)).status_code == 409
    assert state(dose)[0] == DoseStatus.SKIPPED


def test_taken_by_link_is_not_overwritten_by_missed_job(client, patient):
    dose = make_dose(patient, timezone.now() - timedelta(hours=5), DoseStatus.REMINDED)
    client.post(link_for(dose))
    assert notification_services.mark_missed_doses() == 0
    assert state(dose)[0] == DoseStatus.TAKEN


# --- token properties -----------------------------------------------------------------
def test_token_expires_after_24_hours(client, patient):
    dose = make_dose(patient, timezone.now(), DoseStatus.REMINDED)
    url = link_for(dose)
    with shifted_clock(24 * 3600 - 60):
        assert client.get(url).status_code == 200  # still valid just before 24h
    with shifted_clock(24 * 3600 + 60):
        assert client.get(url).status_code == 410
        assert client.post(url).status_code == 410
    assert state(dose)[0] == DoseStatus.REMINDED


def test_token_for_one_dose_cannot_act_on_another(client, patient):
    mine = make_dose(patient, timezone.now(), DoseStatus.REMINDED)
    other = make_dose(patient, timezone.now() + timedelta(hours=12), DoseStatus.REMINDED)
    client.post(link_for(mine))
    assert state(mine)[0] == DoseStatus.TAKEN and state(other)[0] == DoseStatus.REMINDED


def test_token_with_wrong_patient_id_is_rejected(client, patient, other_patient):
    dose = make_dose(patient, timezone.now(), DoseStatus.REMINDED)
    forged = signing.dumps({"dose": dose.id, "patient": other_patient.id}, salt=links.SALT)
    resp = client.post(f"/dose/taken/{forged}/")
    assert resp.status_code == 404
    assert state(dose) == (DoseStatus.REMINDED, None, False)


def test_token_payload_contains_dose_and_patient(patient):
    dose = make_dose(patient, timezone.now())
    assert links.read_token(links.make_token(dose)) == (dose.id, patient.id)


def test_tampered_and_garbage_tokens_are_rejected(client, patient):
    dose = make_dose(patient, timezone.now(), DoseStatus.REMINDED)
    token = links.make_token(dose)
    flipped = token[:-1] + ("A" if token[-1] != "A" else "B")
    wrong_purpose = signing.dumps({"dose": dose.id, "patient": patient.id}, salt="something-else")
    for bad in (flipped, "garbage", wrong_purpose, token.split(":")[0]):
        assert client.post(f"/dose/taken/{bad}/").status_code == 400
    assert state(dose)[0] == DoseStatus.REMINDED


@pytest.mark.parametrize("payload", [{"dose": "1", "patient": 1}, {"dose": 1}, ["x"], 5])
def test_signed_but_malformed_payload_is_rejected(client, payload):
    token = signing.dumps(payload, salt=links.SALT)
    assert client.post(f"/dose/taken/{token}/").status_code == 400


def test_deleted_dose_gives_404_page(client, patient):
    dose = make_dose(patient, timezone.now())
    url = link_for(dose)
    dose.delete()
    assert client.get(url).status_code == 404 and client.post(url).status_code == 404


# --- the email --------------------------------------------------------------------------
def test_reminder_email_contains_a_working_one_click_link(client, patient, mailoutbox):
    dose = make_dose(patient, timezone.now(), DoseStatus.PENDING)
    for res in notification_services.dispatch():
        notification_services.deliver(res.log_id, res.token)
    assert len(mailoutbox) == 1
    [link] = re.findall(r"http://localhost:8000(/dose/taken/\S+)", mailoutbox[0].body)
    assert client.get(link).status_code == 200
    assert state(dose)[0] == DoseStatus.REMINDED  # opening the link changed nothing
    client.post(link)
    assert state(dose)[0] == DoseStatus.TAKEN


def test_site_base_url_is_configurable(patient, settings):
    settings.SITE_BASE_URL = "https://reminders.example.org/"
    dose = make_dose(patient, timezone.now())
    assert links.dose_link(dose).startswith("https://reminders.example.org/dose/taken/")
