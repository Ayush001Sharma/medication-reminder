"""Guards the query indexes: they exist, and the real queries are still able to use them.

WHY THESE TESTS ARE WRITTEN THIS WAY
------------------------------------
Which index PostgreSQL *prefers* depends on table statistics and maintenance (``ANALYZE``, ``VACUUM``,
leftovers from earlier tests), so a test that asserts "the planner picked index X" is a coin flip on a test
database. A real CI failure proved it: when statistics said "one patient owns the whole table", the planner
chose the ``medication_id`` foreign-key index (it delivers rows already sorted for the GROUP BY) instead of the
covering index.

So each plan test asks a question that has one answer whatever the statistics are: **is index X usable for this
query?** Inside the test's own transaction we drop every other index on the table (PostgreSQL DDL is
transactional, so the rollback restores them all) and switch sequential scans off. The only valid plan that
touches the table must then use index X, and the assertion fails if a query or an index predicate is ever
changed so that they no longer match. No competing index can win, whatever the statistics say.

``table_statistics`` runs every plan test under three very different sets of planner statistics (empty tables,
one patient owning everything, many patients) to prove the result does not depend on them. The negative controls
prove the checks can still fail, so they are not vacuous.
"""
import re
from datetime import timedelta
from zoneinfo import ZoneInfo

import pytest
from django.db import connection
from django.db.models import Count, Q
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from accounts.models import Role, User
from conftest import make_dose
from medications.models import Medication
from notifications import conf, services
from notifications.models import NotificationLog, NotificationStatus
from reports.ranges import build_range
from reports.services import adherence_report
from scheduling.models import DoseEvent, DoseStatus

pytestmark = pytest.mark.django_db

DOSES, LOGS = "scheduling_doseevent", "notifications_notificationlog"


# --- helpers ------------------------------------------------------------------------------------
def index_definitions():
    with connection.cursor() as cursor:
        cursor.execute("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()")
        return dict(cursor.fetchall())


def only_usable_index(table: str, keep: str) -> None:
    """Make ``keep`` the only index on ``table`` for the rest of this test's transaction.

    Constraint-backed indexes (primary key, unique) cannot be dropped on their own, so their constraints are
    dropped (CASCADE also drops foreign keys that point at them). Everything is rolled back with the test.
    """
    with connection.cursor() as cursor:
        # Rows inserted earlier in this transaction have deferred foreign-key checks queued, and PostgreSQL
        # refuses ALTER TABLE while any are pending. Run (and so validate) them now.
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
        cursor.execute(
            "SELECT conname FROM pg_constraint WHERE conrelid = %s::regclass AND contype IN ('p', 'u')", [table]
        )
        for (name,) in cursor.fetchall():
            cursor.execute(f'ALTER TABLE "{table}" DROP CONSTRAINT "{name}" CASCADE')
        cursor.execute(
            "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() "
            "AND tablename = %s AND indexname <> %s", [table, keep],
        )
        for (name,) in cursor.fetchall():
            cursor.execute(f'DROP INDEX "{name}"')
        cursor.execute(
            "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = %s", [table]
        )
        assert [row[0] for row in cursor.fetchall()] == [keep], "the test setup must leave exactly one index"


def plan(queryset) -> str:
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL enable_seqscan = off")
    return queryset.explain()


def index_conditions(plan_text: str) -> str:
    """The ``Index Cond`` lines: what the index is actually searched BY (not merely that it appears)."""
    return " ".join(re.findall(r"Index Cond: (.*)", plan_text))


def assert_searched_by(plan_text: str, index: str, pattern: str) -> None:
    """The index is used AND its search condition matches ``pattern``.

    Appearing in a plan is not enough: a btree can be scanned in full using a non-leading column, which is
    correct but slow. Checking the condition proves the index is used for what it was built for (for example
    that ``patient_id`` is the leading column of the lookup).
    """
    assert index in plan_text, f"{index} not used:\n{plan_text}"
    assert re.search(pattern, index_conditions(plan_text)), (
        f"{index} is used, but not searched by /{pattern}/:\n{plan_text}"
    )


# --- planner statistics scenarios ---------------------------------------------------------------------
@pytest.fixture(params=["empty_tables", "one_patient_owns_everything", "many_patients"])
def table_statistics(request, patient):
    """Fill the tables, then ANALYZE, so planner statistics differ wildly from scenario to scenario.

    ``one_patient_owns_everything`` is the state that made the planner pick the wrong index in CI.
    ANALYZE (unlike VACUUM) is allowed inside the test's transaction.
    """
    if request.param == "empty_tables":
        return request.param
    owners = [patient]
    if request.param == "many_patients":
        User.objects.bulk_create(
            [User(email=f"stats{i}@example.com", password="!", role=Role.PATIENT) for i in range(30)]
        )
        owners += list(User.objects.filter(email__startswith="stats"))
    medications = {
        owner.pk: med for owner, med in zip(owners, Medication.objects.bulk_create(
            [Medication(patient=o, name="M", dosage="1", start_date=timezone.now().date()) for o in owners]))
    }
    now = timezone.now()
    cycle = [DoseStatus.TAKEN, DoseStatus.TAKEN, DoseStatus.MISSED, DoseStatus.SKIPPED, DoseStatus.TAKEN]
    doses = DoseEvent.objects.bulk_create([
        DoseEvent(
            patient=owners[i % len(owners)], medication=medications[owners[i % len(owners)].pk],
            scheduled_at=now + timedelta(minutes=i) if i % 97 == 0 else now - timedelta(minutes=i + 1),
            status=DoseStatus.PENDING if i % 97 == 0 else cycle[i % 5],
        )
        for i in range(3000)
    ], batch_size=1000)
    NotificationLog.objects.bulk_create([
        NotificationLog(
            dose_event=dose, channel="email", next_attempt_at=now - timedelta(minutes=i),
            status=NotificationStatus.SENDING if i % 100 == 0 else NotificationStatus.SENT,
        )
        for i, dose in enumerate(doses[:2000])
    ], batch_size=1000)
    with connection.cursor() as cursor:
        cursor.execute(f"ANALYZE {DOSES}, {LOGS}, medications_medication, accounts_user")
    return request.param


# --- the real queries (the same shapes the application runs) --------------------------------------------
def claim_query():
    now = timezone.now()
    return (
        DoseEvent.objects.filter(
            status=DoseStatus.PENDING, scheduled_at__gte=now - conf.grace(),
            scheduled_at__lte=now + conf.lead(), medication__is_active=True,
        )
        .filter(services._wants_any_channel(["email"]))
        .order_by("scheduled_at")[:200]
    )


def missed_job_query():
    return DoseEvent.objects.filter(
        status__in=[DoseStatus.PENDING, DoseStatus.REMINDED], scheduled_at__lt=timezone.now()
    )


def latest_missed_query(patient):
    return DoseEvent.objects.filter(
        patient=patient, status=DoseStatus.MISSED, scheduled_at__lte=timezone.now()
    ).order_by("-scheduled_at")[:1]


def retry_scan_query():
    now = timezone.now()
    return NotificationLog.objects.filter(status=NotificationStatus.SENDING, next_attempt_at__lte=now).filter(
        Q(lease_until__isnull=True) | Q(lease_until__lte=now)
    ).order_by("next_attempt_at")[:200]


def report_aggregate_query(patient):
    now = timezone.now()
    return (
        DoseEvent.objects.filter(
            patient=patient, scheduled_at__gte=now - timedelta(days=30), scheduled_at__lt=now,
            status__in=["taken", "missed", "skipped"],
        )
        .order_by()
        .values("medication_id")
        .annotate(taken=Count("status", filter=Q(status="taken")),
                  late=Count("status", filter=Q(status="taken", taken_late=True)))
    )


def patient_range_query(patient):
    now = timezone.now()
    return DoseEvent.objects.filter(patient=patient, scheduled_at__gte=now - timedelta(days=30), scheduled_at__lt=now)


# --- the indexes exist (catalog checks: no planner involved) ---------------------------------------------
def test_expected_indexes_exist_with_the_right_shape():
    defs = index_definitions()
    assert "WHERE" in defs["dose_open_idx"] and "pending" in defs["dose_open_idx"]
    assert "INCLUDE (status, medication_id, taken_late)" in defs["dose_patient_cover_idx"]
    assert "WHERE" in defs["dose_patient_missed_idx"] and "missed" in defs["dose_patient_missed_idx"]
    assert "WHERE" in defs["notif_sending_idx"] and "sending" in defs["notif_sending_idx"]


def test_superseded_indexes_are_gone():
    defs = index_definitions()
    for old in ("dose_status_time_idx", "dose_patient_time_idx", "notif_status_next_idx"):
        assert old not in defs


# --- each real query can use its index, whatever the planner statistics are -----------------------------------
def test_claim_query_can_use_the_open_dose_index(table_statistics):
    only_usable_index(DOSES, "dose_open_idx")
    assert_searched_by(plan(claim_query()), "dose_open_idx", r"scheduled_at >=")  # a bounded range, not a full scan


def test_missed_job_filter_can_use_the_open_dose_index(table_statistics):
    only_usable_index(DOSES, "dose_open_idx")
    assert_searched_by(plan(missed_job_query()), "dose_open_idx", r"scheduled_at <")


def test_latest_missed_dose_can_use_its_partial_index(table_statistics, patient):
    only_usable_index(DOSES, "dose_patient_missed_idx")
    assert_searched_by(plan(latest_missed_query(patient)), "dose_patient_missed_idx", r"^\(*patient_id = \d+")


def test_retry_scan_can_use_the_sending_index(table_statistics):
    only_usable_index(LOGS, "notif_sending_idx")
    assert_searched_by(plan(retry_scan_query()), "notif_sending_idx", r"next_attempt_at <=")


def test_report_aggregate_can_use_the_covering_index(table_statistics, patient):
    only_usable_index(DOSES, "dose_patient_cover_idx")
    assert_searched_by(plan(report_aggregate_query(patient)), "dose_patient_cover_idx", r"^\(*patient_id = \d+")


def test_patient_time_range_can_use_the_covering_index(table_statistics, patient):
    only_usable_index(DOSES, "dose_patient_cover_idx")
    assert_searched_by(plan(patient_range_query(patient)), "dose_patient_cover_idx", r"^\(*patient_id = \d+")


# --- negative controls: the checks above can fail --------------------------------------------------------------
@pytest.mark.parametrize("table,index,make_query", [
    # status = 'taken' does not imply the partial predicate, so the partial index must be unusable
    (DOSES, "dose_open_idx", lambda patient: DoseEvent.objects.filter(status=DoseStatus.TAKEN, scheduled_at__lt=timezone.now())),
    (DOSES, "dose_patient_missed_idx", lambda patient: DoseEvent.objects.filter(
        patient=patient, status=DoseStatus.TAKEN, scheduled_at__lte=timezone.now()).order_by("-scheduled_at")[:1]),
    (LOGS, "notif_sending_idx", lambda patient: NotificationLog.objects.filter(
        status=NotificationStatus.SENT, next_attempt_at__lte=timezone.now()).order_by("next_attempt_at")[:200]),
])
def test_a_query_outside_the_index_predicate_cannot_use_it(table, index, make_query, patient):
    only_usable_index(table, index)
    result = plan(make_query(patient))
    assert index not in result and "Seq Scan" in result


# --- the report must stay answerable from the covering index ---------------------------------------------------
def test_report_never_counts_the_primary_key(patient):
    """COUNT(id) would force table access and lose the index-only scan (see reports/services.py)."""
    make_dose(patient, timezone.now() - timedelta(hours=1), DoseStatus.TAKEN)
    today = timezone.now().date()
    rng = build_range(today - timedelta(days=2), today, ZoneInfo("UTC"))
    with CaptureQueriesContext(connection) as queries:
        adherence_report(patient, rng, timezone.now())
    assert 'COUNT("scheduling_doseevent"."id")' not in " ".join(q["sql"] for q in queries)
