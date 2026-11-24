"""Guards the query indexes: they exist, and the real queries are still able to use them.

Tables are tiny in tests, so PostgreSQL would normally pick a sequential scan. We switch that off
(inside the test's transaction only) to ask "CAN the planner use this index for this query?",
which fails if a query or an index predicate is changed so that they no longer match.
"""
from datetime import timedelta
from zoneinfo import ZoneInfo

import pytest
from django.db import connection
from django.db.models import Q
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from conftest import make_dose
from notifications import conf, services
from notifications.models import NotificationLog, NotificationStatus
from reports.ranges import build_range
from reports.services import adherence_report
from scheduling.models import DoseEvent, DoseStatus

pytestmark = pytest.mark.django_db


def index_definitions():
    with connection.cursor() as cursor:
        cursor.execute("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()")
        return dict(cursor.fetchall())


def plan(queryset) -> str:
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL enable_seqscan = off")
    return queryset.explain()


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


def test_claim_query_can_use_the_open_dose_index(patient):
    now = timezone.now()
    qs = (
        DoseEvent.objects.filter(
            status=DoseStatus.PENDING, scheduled_at__gte=now - conf.grace(),
            scheduled_at__lte=now + conf.lead(), medication__is_active=True,
        )
        .filter(services._wants_any_channel(["email"]))
        .order_by("scheduled_at")[:200]
    )
    assert "dose_open_idx" in plan(qs)


def test_missed_job_filter_can_use_the_open_dose_index():
    qs = DoseEvent.objects.filter(
        status__in=[DoseStatus.PENDING, DoseStatus.REMINDED], scheduled_at__lt=timezone.now()
    )
    assert "dose_open_idx" in plan(qs)


def test_latest_missed_dose_can_use_its_partial_index(patient):
    qs = DoseEvent.objects.filter(patient=patient, status=DoseStatus.MISSED, scheduled_at__lte=timezone.now())
    assert "dose_patient_missed_idx" in plan(qs.order_by("-scheduled_at")[:1])


def test_retry_scan_can_use_the_sending_index():
    now = timezone.now()
    qs = NotificationLog.objects.filter(status=NotificationStatus.SENDING, next_attempt_at__lte=now).filter(
        Q(lease_until__isnull=True) | Q(lease_until__lte=now)
    ).order_by("next_attempt_at")[:200]
    assert "notif_sending_idx" in plan(qs)


def test_patient_time_range_can_use_the_covering_index(patient):
    now = timezone.now()
    qs = DoseEvent.objects.filter(patient=patient, scheduled_at__gte=now - timedelta(days=30), scheduled_at__lt=now)
    assert "dose_patient_cover_idx" in plan(qs)


def test_report_never_counts_the_primary_key(patient):
    """COUNT(id) would force table access and lose the index-only scan (see reports/services.py)."""
    make_dose(patient, timezone.now() - timedelta(hours=1), DoseStatus.TAKEN)
    today = timezone.now().date()
    rng = build_range(today - timedelta(days=2), today, ZoneInfo("UTC"))
    with CaptureQueriesContext(connection) as queries:
        adherence_report(patient, rng, timezone.now())
    assert 'COUNT("scheduling_doseevent"."id")' not in " ".join(q["sql"] for q in queries)
