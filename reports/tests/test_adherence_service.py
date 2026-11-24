"""The adherence definition, tested directly against the service with a fixed ``now``."""
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from conftest import make_dose, make_user
from medications.models import Medication
from reports.ranges import build_range
from reports.services import adherence_percent, adherence_report, current_streak
from scheduling.models import DoseStatus as S

pytestmark = pytest.mark.django_db
NOW = datetime(2030, 6, 20, 12, 0, tzinfo=UTC)
IST = ZoneInfo("Asia/Kolkata")


def at(days_ago, hour=6):
    return NOW.replace(hour=hour) - timedelta(days=days_ago)


def report(patient, start=date(2030, 6, 1), end=date(2030, 6, 30)):
    return adherence_report(patient, build_range(start, end, IST), NOW)


def test_percentage_formula():
    assert adherence_percent(3, 1) == 75.0
    assert adherence_percent(1, 2) == 33.3
    assert adherence_percent(0, 4) == 0.0
    assert adherence_percent(5, 0) == 100.0
    assert adherence_percent(0, 0) is None


def test_definition_late_counts_as_taken_skipped_excluded_pending_and_future_ignored(patient):
    make_dose(patient, at(1), S.TAKEN)
    make_dose(patient, at(2), S.TAKEN)
    make_dose(patient, at(3), S.TAKEN, taken_late=True)  # late: still taken
    make_dose(patient, at(4), S.MISSED)
    make_dose(patient, at(5), S.SKIPPED)
    make_dose(patient, at(6), S.SKIPPED)
    make_dose(patient, at(7), S.PENDING)  # due but unresolved: not counted
    make_dose(patient, at(8), S.REMINDED)  # due but unresolved: not counted
    make_dose(patient, NOW + timedelta(hours=1), S.PENDING)  # future
    make_dose(patient, NOW + timedelta(hours=2), S.TAKEN)  # future, taken early: not counted

    totals = report(patient)["totals"]
    assert totals == {
        "taken": 3, "taken_late": 1, "missed": 1, "skipped": 2,
        "total": 6, "adherence_percent": 75.0,  # 3 / (3 + 1); skipped left out
    }


def test_no_taken_or_missed_gives_null_percentage(patient):
    make_dose(patient, at(1), S.SKIPPED)
    make_dose(patient, at(2), S.PENDING)
    totals = report(patient)["totals"]
    assert totals["adherence_percent"] is None and totals["skipped"] == 1


def test_empty_report(patient):
    r = report(patient)
    assert r["totals"]["total"] == 0 and r["medications"] == [] and r["current_streak"] == 0


def test_per_medication_breakdown(patient):
    a = Medication.objects.create(patient=patient, name="Aspirin", dosage="75 mg", start_date=date(2030, 1, 1))
    b = Medication.objects.create(patient=patient, name="Metformin", dosage="500 mg", start_date=date(2030, 1, 1))
    from scheduling.models import DoseEvent
    for days_ago, status, med in [(1, S.TAKEN, a), (2, S.TAKEN, a), (3, S.MISSED, a),
                                  (1, S.MISSED, b), (2, S.SKIPPED, b), (3, S.TAKEN, b)]:
        DoseEvent.objects.create(patient=patient, medication=med, scheduled_at=at(days_ago), status=status)
    rows = {m["name"]: m for m in report(patient)["medications"]}
    assert list(rows) == ["Aspirin", "Metformin"]
    assert (rows["Aspirin"]["taken"], rows["Aspirin"]["missed"], rows["Aspirin"]["adherence_percent"]) == (2, 1, 66.7)
    assert (rows["Metformin"]["taken"], rows["Metformin"]["skipped"], rows["Metformin"]["adherence_percent"]) == (1, 1, 50.0)
    assert rows["Aspirin"]["dosage"] == "75 mg"
    assert report(patient)["totals"]["total"] == 6


def test_other_patients_doses_are_never_included(patient, other_patient):
    make_dose(patient, at(1), S.TAKEN)
    make_dose(other_patient, at(1), S.MISSED)
    assert report(patient)["totals"]["taken"] == 1 and report(patient)["totals"]["missed"] == 0


# --- streak -----------------------------------------------------------------------
def test_streak_counts_taken_doses_since_last_missed_ignoring_skipped_and_unresolved(patient):
    make_dose(patient, at(9), S.TAKEN)  # before the miss: does not count
    make_dose(patient, at(8), S.MISSED)
    make_dose(patient, at(7), S.TAKEN)
    make_dose(patient, at(6), S.SKIPPED)  # neither breaks nor extends
    make_dose(patient, at(5), S.TAKEN, taken_late=True)  # late is still taken
    make_dose(patient, at(4), S.PENDING)  # unresolved: ignored
    make_dose(patient, at(3), S.TAKEN)
    make_dose(patient, NOW + timedelta(days=1), S.TAKEN)  # future: ignored
    assert current_streak(patient, NOW) == 3


def test_streak_without_any_missed_counts_all_taken(patient):
    for d in range(1, 5):
        make_dose(patient, at(d), S.TAKEN)
    assert current_streak(patient, NOW) == 4


def test_streak_is_zero_when_latest_resolved_dose_is_missed(patient):
    make_dose(patient, at(2), S.TAKEN)
    make_dose(patient, at(1), S.MISSED)
    assert current_streak(patient, NOW) == 0


def test_streak_ignores_the_report_range_and_other_patients(patient, other_patient):
    for d in range(1, 4):
        make_dose(patient, at(d), S.TAKEN)
    make_dose(other_patient, at(1), S.MISSED)
    one_day = adherence_report(patient, build_range(date(2030, 6, 19), date(2030, 6, 19), IST), NOW)
    assert one_day["totals"]["taken"] == 1 and one_day["current_streak"] == 3


# --- date ranges are local to the patient ---------------------------------------------
def test_range_uses_the_patients_local_dates(patient):
    # 18:45Z on 1 June is 00:15 IST on 2 June.
    make_dose(patient, datetime(2030, 6, 1, 18, 45, tzinfo=UTC), S.TAKEN)
    # 18:15Z on 1 June is 23:45 IST on 1 June.
    make_dose(patient, datetime(2030, 6, 1, 18, 15, tzinfo=UTC), S.MISSED)
    june_1 = report(patient, date(2030, 6, 1), date(2030, 6, 1))["totals"]
    june_2 = report(patient, date(2030, 6, 2), date(2030, 6, 2))["totals"]
    assert (june_1["missed"], june_1["taken"]) == (1, 0)
    assert (june_2["taken"], june_2["missed"]) == (1, 0)


def test_range_is_inclusive_and_end_exclusive_boundary_is_local_midnight(patient):
    make_dose(patient, datetime(2030, 5, 31, 18, 30, tzinfo=UTC), S.TAKEN)  # 00:00 IST, 1 June: in
    make_dose(patient, datetime(2030, 5, 31, 18, 29, tzinfo=UTC), S.TAKEN)  # 23:59 IST, 31 May: out
    make_dose(patient, datetime(2030, 6, 1, 18, 30, tzinfo=UTC), S.TAKEN)  # 00:00 IST, 2 June: out
    assert report(patient, date(2030, 6, 1), date(2030, 6, 1))["totals"]["taken"] == 1


def test_new_york_range_across_a_dst_change(db):
    ny = make_user("ny@example.com", tz="America/New_York")
    zone = ZoneInfo("America/New_York")
    make_dose(ny, datetime(2030, 3, 10, 5, 0, tzinfo=UTC), S.TAKEN)  # 00:00 EST... 10 Mar is spring-forward day
    make_dose(ny, datetime(2030, 3, 11, 3, 59, tzinfo=UTC), S.TAKEN)  # 23:59 EDT, still 10 Mar
    make_dose(ny, datetime(2030, 3, 11, 4, 0, tzinfo=UTC), S.TAKEN)  # 00:00 EDT, 11 Mar
    rng = build_range(date(2030, 3, 10), date(2030, 3, 10), zone)
    assert adherence_report(ny, rng, NOW)["totals"]["taken"] == 2  # a 23-hour day


# --- efficiency ------------------------------------------------------------------------
def test_report_uses_a_fixed_number_of_queries_regardless_of_size(patient):
    from scheduling.models import DoseEvent
    med = Medication.objects.create(patient=patient, name="M", dosage="1", start_date=date(2030, 1, 1))
    statuses = [S.TAKEN, S.MISSED, S.SKIPPED]
    DoseEvent.objects.bulk_create([
        DoseEvent(patient=patient, medication=med, scheduled_at=NOW - timedelta(hours=i + 1), status=statuses[i % 3])
        for i in range(300)
    ])
    with CaptureQueriesContext(connection) as small:
        report(patient, date(2030, 6, 20), date(2030, 6, 20))
    with CaptureQueriesContext(connection) as large:
        r = report(patient, date(2030, 6, 1), date(2030, 6, 30))
    assert r["totals"]["total"] == 300
    assert len(small) == len(large) <= 4
