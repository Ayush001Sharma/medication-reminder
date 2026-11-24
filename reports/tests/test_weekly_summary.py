import threading
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.db import IntegrityError, connection, transaction

from accounts.models import Role
from conftest import client_for, make_dose, make_grant, make_user
from reports import summary
from reports.models import AuditAction, AuditLog, SummaryStatus, WeeklySummary
from reports.tasks import send_weekly_summaries as weekly_task
from scheduling.models import DoseStatus as S

pytestmark = pytest.mark.django_db
IST, NY = ZoneInfo("Asia/Kolkata"), ZoneInfo("America/New_York")


def local(day, hour=12, minute=0, tz=IST):
    """UTC instant for a local wall-clock time."""
    return datetime(2030, 6, day, hour, minute, tzinfo=tz).astimezone(UTC)


MON_8AM = local(10, 8)  # Monday 2030-06-10 08:00 IST: week Mon 3 Jun - Sun 9 Jun is complete


@pytest.fixture
def week_of_doses(patient):
    """Two taken + one missed inside the IST week; edge doses just outside it."""
    make_dose(patient, local(3, 0, 10), S.TAKEN)  # Mon 00:10 IST = Sun 18:40 UTC: inside
    make_dose(patient, local(6, 9), S.TAKEN)
    make_dose(patient, local(9, 23, 30), S.MISSED)  # Sun 23:30 IST: inside
    make_dose(patient, local(2, 23, 50), S.MISSED)  # Sun the week before: outside
    make_dose(patient, local(10, 0, 30), S.MISSED)  # Mon 00:30 IST (still Sun in UTC): next week
    return patient


def subjects(mailoutbox):
    return sorted(m.to[0] for m in mailoutbox)


# --- week boundaries in the patient's timezone -------------------------------------------
def test_week_boundaries_follow_the_patients_timezone(week_of_doses, mailoutbox):
    assert summary.send_weekly_summaries(now=MON_8AM) == 1
    record = WeeklySummary.objects.get()
    assert (record.week_start, record.week_end) == (date(2030, 6, 3), date(2030, 6, 9))
    body = mailoutbox[0].body
    assert "Week: 03 Jun - 09 Jun 2030 (Asia/Kolkata)" in body
    assert "Adherence: 66.7% (2 taken, 1 missed)" in body  # edge doses on either side excluded
    assert "Metformin (500 mg): 66.7%" in body and "Current streak: 0" in body
    assert mailoutbox[0].subject == "Your weekly adherence summary (03 Jun - 09 Jun 2030)"


def test_not_sent_before_the_local_send_hour_on_monday(week_of_doses, mailoutbox):
    assert summary.send_weekly_summaries(now=local(10, 7, 59)) == 0
    assert mailoutbox == [] and not WeeklySummary.objects.exists()
    assert summary.send_weekly_summaries(now=MON_8AM) == 1


def test_a_week_is_never_summarised_before_it_has_ended(week_of_doses):
    """On Sunday 23:59 the latest COMPLETE week is the previous one (27 May - 2 Jun)."""
    summary.send_weekly_summaries(now=local(9, 23, 59))
    assert not WeeklySummary.objects.filter(week_start=date(2030, 6, 3)).exists()
    assert list(WeeklySummary.objects.values_list("week_start", flat=True)) == [date(2030, 5, 27)]


def test_send_hour_is_configurable(week_of_doses, settings):
    settings.WEEKLY_SUMMARY_LOCAL_HOUR = 18
    assert summary.send_weekly_summaries(now=MON_8AM) == 0
    assert summary.send_weekly_summaries(now=local(10, 18)) == 1


def test_a_run_later_in_the_week_catches_up_for_the_same_week(week_of_doses, mailoutbox):
    assert summary.send_weekly_summaries(now=local(12, 15)) == 1  # Wednesday: worker was down Monday
    assert "03 Jun - 09 Jun" in mailoutbox[0].body


def test_each_timezone_is_served_when_its_own_week_ends(db, mailoutbox):
    kolkata, new_york = make_user("k@example.com", tz="Asia/Kolkata"), make_user("n@example.com", tz="America/New_York")
    make_dose(kolkata, local(5, 9), S.TAKEN)
    make_dose(new_york, local(9, 23, 30, NY), S.TAKEN)  # Sun 23:30 EDT = Mon 03:30 UTC: still the NY week
    make_dose(new_york, local(10, 0, 30, NY), S.MISSED)  # Mon 00:30 EDT: NEXT week for New York

    at = local(10, 8)  # 08:00 IST = 22:30 EDT Sunday: New York's week is not over yet
    assert summary.send_weekly_summaries(now=at) == 1 and subjects(mailoutbox) == ["k@example.com"]
    assert summary.send_weekly_summaries(now=local(10, 8, tz=NY)) == 1  # 08:00 EDT Monday
    assert subjects(mailoutbox) == ["k@example.com", "n@example.com"]
    ny_body = [m for m in mailoutbox if m.to == ["n@example.com"]][0].body
    assert "(America/New_York)" in ny_body and "Adherence: 100.0% (1 taken, 0 missed)" in ny_body


# --- who receives it ----------------------------------------------------------------------
def test_goes_to_the_patient_and_every_active_grantee_only(week_of_doses, mailoutbox, caregiver, doctor):
    pending, revoked = make_user("pending@example.com", Role.CAREGIVER), make_user("revoked@example.com", Role.DOCTOR)
    make_grant(week_of_doses, caregiver)
    make_grant(week_of_doses, doctor)
    make_grant(week_of_doses, pending, "pending")
    make_grant(week_of_doses, revoked, "revoked")
    assert summary.send_weekly_summaries(now=MON_8AM) == 3
    assert subjects(mailoutbox) == sorted([week_of_doses.email, caregiver.email, doctor.email])
    grantee_mail = [m for m in mailoutbox if m.to == [caregiver.email]][0]
    assert grantee_mail.subject == f"Weekly adherence summary for patient {week_of_doses.id} (03 Jun - 09 Jun 2030)"


def test_patient_with_email_off_is_skipped_but_grantees_still_get_it(week_of_doses, mailoutbox, caregiver):
    week_of_doses.patient_profile.notification_preferences = {"email": False}
    week_of_doses.patient_profile.save()
    make_grant(week_of_doses, caregiver)
    summary.send_weekly_summaries(now=MON_8AM)
    assert subjects(mailoutbox) == [caregiver.email]


def test_patients_with_no_resolved_doses_that_week_get_nothing(patient, mailoutbox):
    make_dose(patient, local(5, 9), S.PENDING)  # unresolved
    make_dose(patient, local(20, 9), S.TAKEN)  # a different week
    assert summary.send_weekly_summaries(now=MON_8AM) == 0
    assert mailoutbox == [] and not WeeklySummary.objects.exists()


def test_inactive_patients_are_skipped(week_of_doses, mailoutbox):
    week_of_doses.is_active = False
    week_of_doses.save()
    assert summary.send_weekly_summaries(now=MON_8AM) == 0


def test_revocation_between_claim_and_send_wins(week_of_doses, mailoutbox, caregiver):
    grant = make_grant(week_of_doses, caregiver)
    week = summary.Week(date(2030, 6, 3), date(2030, 6, 9))
    record = summary._claim(week_of_doses, week, caregiver)
    grant.status, grant.revoked_at = "revoked", datetime.now(UTC)
    grant.save()
    report = {"patient": {"id": 1, "full_name": "", "timezone": "Asia/Kolkata"}, "totals": {}, "medications": [], "current_streak": 0}
    assert summary._deliver(record, week_of_doses, caregiver, report, week) is False
    record.refresh_from_db()
    assert record.status == SummaryStatus.CANCELLED and mailoutbox == []


def test_a_grantee_added_later_in_the_week_gets_theirs_without_duplicating_others(week_of_doses, mailoutbox, caregiver):
    summary.send_weekly_summaries(now=MON_8AM)
    make_grant(week_of_doses, caregiver)
    assert summary.send_weekly_summaries(now=local(11, 9)) == 1  # only the newcomer
    assert subjects(mailoutbox) == sorted([week_of_doses.email, caregiver.email])


# --- never twice -----------------------------------------------------------------------------
def test_running_twice_sends_no_duplicates(week_of_doses, mailoutbox, caregiver, doctor):
    make_grant(week_of_doses, caregiver)
    make_grant(week_of_doses, doctor)
    assert summary.send_weekly_summaries(now=MON_8AM) == 3
    assert summary.send_weekly_summaries(now=MON_8AM) == 0
    assert summary.send_weekly_summaries(now=local(11, 12)) == 0  # later the same week
    assert len(mailoutbox) == 3 and WeeklySummary.objects.count() == 3
    assert {r.status for r in WeeklySummary.objects.all()} == {SummaryStatus.SENT}


def test_next_week_is_a_new_summary(week_of_doses, mailoutbox):
    make_dose(week_of_doses, local(12, 9), S.TAKEN)  # inside the following IST week (10-16 Jun)
    summary.send_weekly_summaries(now=MON_8AM)
    assert summary.send_weekly_summaries(now=local(17, 8)) == 1
    assert [r.week_start for r in WeeklySummary.objects.order_by("week_start")] == [date(2030, 6, 3), date(2030, 6, 10)]


def test_database_rejects_a_duplicate_record(week_of_doses, caregiver):
    kwargs = dict(patient=week_of_doses, recipient=caregiver, week_start=date(2030, 6, 3), week_end=date(2030, 6, 9))
    WeeklySummary.objects.create(**kwargs)
    with pytest.raises(IntegrityError), transaction.atomic():
        WeeklySummary.objects.create(**kwargs)


def test_message_id_is_stable_per_record(week_of_doses, mailoutbox):
    summary.send_weekly_summaries(now=MON_8AM)
    record = WeeklySummary.objects.get()
    assert mailoutbox[0].extra_headers["Message-ID"] == f"<weekly-summary-{record.pk}@medreminder.local>"


# --- failures ----------------------------------------------------------------------------------
class Outage:
    def __init__(self, failures, real):
        self.failures, self.calls, self.real = failures, 0, real

    def __call__(self, message):
        self.calls += 1
        if self.calls <= self.failures:
            raise ConnectionError("SMTP down")
        self.real(message)


def test_failed_send_is_recorded_then_retried_once_and_not_duplicated(week_of_doses, mailoutbox, monkeypatch):
    monkeypatch.setattr(summary, "_send_email", Outage(1, summary._send_email))
    assert summary.send_weekly_summaries(now=MON_8AM) == 0
    record = WeeklySummary.objects.get()
    assert (record.status, record.attempts, record.error) == (SummaryStatus.FAILED, 1, "ConnectionError: SMTP down")
    assert summary.send_weekly_summaries(now=local(10, 9)) == 1  # next hourly run retries
    record.refresh_from_db()
    assert (record.status, record.attempts, record.error) == (SummaryStatus.SENT, 2, "")
    assert summary.send_weekly_summaries(now=local(10, 10)) == 0
    assert len(mailoutbox) == 1


def test_gives_up_after_the_maximum_attempts(week_of_doses, mailoutbox, monkeypatch, settings):
    settings.WEEKLY_SUMMARY_MAX_ATTEMPTS = 3
    monkeypatch.setattr(summary, "_send_email", Outage(99, summary._send_email))
    for hour in range(8, 14):
        summary.send_weekly_summaries(now=local(10, hour))
    record = WeeklySummary.objects.get()
    assert (record.status, record.attempts) == (SummaryStatus.FAILED, 3) and mailoutbox == []


def test_one_recipients_failure_does_not_block_the_others(week_of_doses, mailoutbox, caregiver, monkeypatch):
    make_grant(week_of_doses, caregiver)
    real = summary._send_email

    def fail_for_patient(message):
        if message.to == [week_of_doses.email]:
            raise ConnectionError("bounce")
        real(message)
    monkeypatch.setattr(summary, "_send_email", fail_for_patient)
    assert summary.send_weekly_summaries(now=MON_8AM) == 1
    assert subjects(mailoutbox) == [caregiver.email]


# --- audit ------------------------------------------------------------------------------------
def test_emailing_a_grantee_is_audited_and_the_patient_can_see_it(week_of_doses, patient_api, caregiver):
    make_grant(week_of_doses, caregiver)
    summary.send_weekly_summaries(now=MON_8AM)
    entry = AuditLog.objects.get()  # only the grantee, not the patient's own copy
    assert (entry.viewer, entry.patient, entry.action) == (caregiver, week_of_doses, AuditAction.WEEKLY_SUMMARY)
    assert (entry.range_start, entry.range_end) == (date(2030, 6, 3), date(2030, 6, 9))
    assert patient_api.get("/api/audit-log/").json()["results"][0]["action"] == "weekly_summary"


# --- concurrency (real threads, real PostgreSQL) -----------------------------------------------
@pytest.mark.django_db(transaction=True)
def test_overlapping_runs_send_each_summary_exactly_once(week_of_doses, mailoutbox, caregiver, doctor):
    make_grant(week_of_doses, caregiver)
    make_grant(week_of_doses, doctor)
    barrier, errors = threading.Barrier(5), []

    def run():
        try:
            barrier.wait(timeout=10)
            summary.send_weekly_summaries(now=MON_8AM)
        except Exception as exc:
            errors.append(exc)
        finally:
            connection.close()

    threads = [threading.Thread(target=run) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert not errors
    assert subjects(mailoutbox) == sorted([week_of_doses.email, caregiver.email, doctor.email])
    assert WeeklySummary.objects.count() == 3


# --- Beat / task wiring --------------------------------------------------------------------------
def test_beat_runs_the_task_hourly(settings):
    entry = [e for e in settings.CELERY_BEAT_SCHEDULE.values() if e["task"] == "reports.tasks.send_weekly_summaries"]
    assert len(entry) == 1
    assert entry[0]["schedule"].minute == {20} and entry[0]["schedule"].hour == set(range(24))  # every hour


def test_task_delegates_to_the_service(monkeypatch):
    monkeypatch.setattr(summary, "send_weekly_summaries", lambda: 7)
    assert weekly_task.apply().successful()
