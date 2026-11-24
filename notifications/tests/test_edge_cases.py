import logging
import uuid
from datetime import timedelta

import pytest

from conftest import make_user
from medications.models import Medication
from notifications import channels, services
from notifications.content import build_reminder
from notifications.models import NotificationLog, NotificationStatus
from scheduling.models import DoseStatus
from scheduling.services import sync_schedule_events

from .factories import create_dose
from .test_pipeline import NOW

pytestmark = pytest.mark.django_db


def test_a_dose_whose_patient_ends_up_with_no_channel_is_left_alone(patient, monkeypatch):
    """Defensive path: the SQL filter and the Python check disagree, so the dose is not claimed."""
    dose = create_dose(patient, NOW)
    monkeypatch.setattr(services, "patient_channels", lambda patient, channels: [])
    assert services.claim_due_doses(now=NOW) == []
    dose.refresh_from_db()
    assert dose.status == DoseStatus.PENDING and not NotificationLog.objects.exists()


def test_a_send_that_outlives_its_lease_is_reported_and_not_recorded_as_ours(patient, mailoutbox, caplog, monkeypatch):
    """Recovery took the row over while the (slow) send was in flight."""
    create_dose(patient, NOW)
    [res] = services.claim_due_doses(now=NOW)
    real_send = channels.EmailChannel.send

    def slow_send(self, message):
        NotificationLog.objects.filter(pk=res.log_id).update(lease_token=uuid.uuid4())  # taken over meanwhile
        real_send(self, message)

    monkeypatch.setattr(channels.EmailChannel, "send", slow_send)
    with caplog.at_level(logging.INFO, logger="notifications.services"):
        assert services.deliver(res.log_id, res.token, now=NOW) == "sent"
    log = NotificationLog.objects.get()
    assert log.status == NotificationStatus.SENDING  # the new owner will finish it
    assert any(getattr(r, "event", "") == "reminder.lease_lost_after_send" and r.levelname == "WARNING"
               for r in caplog.records)
    assert log.dose_event.reminder_sent_at is None and len(mailoutbox) == 1


def test_reminder_without_instructions_has_no_instructions_line(patient):
    med = Medication.objects.create(patient=patient, name="Vitamin D", dosage="1000 IU", start_date=NOW.date())
    dose = create_dose(patient, NOW, medication=med)
    log = NotificationLog.objects.create(dose_event=dose, channel="email", next_attempt_at=NOW)
    message = build_reminder(log)
    assert "Instructions" not in message.body and "Vitamin D (1000 IU)" in message.body
    assert message.to_phone == "" and message.to_email == patient.email


def test_reminder_for_a_user_without_a_profile_still_renders(db):
    user = make_user("caregiver-as-patient@example.com", role="caregiver")
    dose = create_dose(user, NOW)
    log = NotificationLog.objects.create(dose_event=dose, channel="email", next_attempt_at=NOW)
    assert build_reminder(log).to_phone == ""


def test_string_representation_of_a_log_row(patient):
    dose = create_dose(patient, NOW)
    log = NotificationLog.objects.create(dose_event=dose, channel="email", next_attempt_at=NOW)
    assert str(log) == f"email for dose {dose.id} [sending]"


def test_syncing_a_schedule_that_no_longer_exists_is_a_no_op():
    assert sync_schedule_events(987654) == 0


def test_model_string_representations(patient):
    med = Medication.objects.create(patient=patient, name="Aspirin", dosage="75 mg", start_date=NOW.date())
    dose = create_dose(patient, NOW, medication=med)
    from scheduling.models import Schedule
    from datetime import time
    schedule = Schedule.objects.create(medication=med, times_of_day=[time(8)], start_date=NOW.date() + timedelta(days=400))
    assert str(med) == f"Aspirin ({patient.id})"
    assert str(dose) == f"{med.id} @ 2030-06-01 02:30Z [pending]"
    assert str(schedule) == f"Schedule {schedule.id} for medication {med.id}"
