from datetime import date

import pytest
from django.contrib import admin
from django.test import Client
from django.urls import reverse

from accounts.models import User
from reports import summary
from reports.models import AuditAction, AuditLog, SummaryStatus, WeeklySummary
from reports.tasks import send_weekly_summaries
from reports.summary import Week, render

pytestmark = pytest.mark.django_db


def test_audit_data_is_read_only_in_the_admin(patient, caregiver):
    audit = AuditLog.objects.create(viewer=caregiver, viewer_email=caregiver.email, viewer_role="caregiver",
                                    patient=patient, action=AuditAction.REPORT_VIEW,
                                    range_start="2030-01-01", range_end="2030-01-02")
    weekly = WeeklySummary.objects.create(patient=patient, recipient=caregiver, week_start="2030-01-07",
                                          week_end="2030-01-13")
    for model, obj in ((AuditLog, audit), (WeeklySummary, weekly)):
        model_admin = admin.site._registry[model]
        assert model_admin.has_add_permission(None) is False
        assert model_admin.has_change_permission(None, obj) is False
        assert model_admin.has_delete_permission(None, obj) is False
    root = User.objects.create_superuser(email="root@example.com", password="x" * 12)
    browser = Client()
    browser.force_login(root)
    assert browser.get(reverse("admin:reports_auditlog_changelist")).status_code == 200
    assert browser.get(reverse("admin:reports_auditlog_add")).status_code == 403
    assert browser.post(reverse("admin:reports_auditlog_delete", args=[audit.pk]), {"post": "yes"}).status_code == 403
    assert AuditLog.objects.filter(pk=audit.pk).exists()


def test_string_representations(patient, caregiver):
    audit = AuditLog.objects.create(viewer=caregiver, viewer_email=caregiver.email, viewer_role="caregiver",
                                    patient=patient, action=AuditAction.REPORT_VIEW,
                                    range_start="2030-01-01", range_end="2030-01-02")
    weekly = WeeklySummary.objects.create(patient=patient, recipient=caregiver, week_start="2030-01-07",
                                          week_end="2030-01-13")
    assert str(audit) == f"caregiver@example.com -> patient {patient.id} [report_view]"
    assert str(weekly) == f"2030-01-07 patient {patient.id} -> {caregiver.id} [sending]"
    assert weekly.status == SummaryStatus.SENDING


def test_summary_without_any_medication_rows_has_no_breakdown_section():
    report = {"patient": {"id": 4, "full_name": "Asha", "timezone": "Asia/Kolkata"}, "medications": [],
              "current_streak": 0,
              "totals": {"adherence_percent": None, "taken": 0, "missed": 0, "taken_late": 0, "skipped": 2}}
    subject, body = render(report, for_patient=False, week=Week(date(2030, 6, 3), date(2030, 6, 9)))
    assert subject == "Weekly adherence summary for Asha (03 Jun - 09 Jun 2030)"
    assert "Adherence: n/a (0 taken, 0 missed)" in body and "By medication" not in body


def test_task_returns_zero_quietly_when_nothing_is_due(monkeypatch):
    monkeypatch.setattr(summary, "send_weekly_summaries", lambda: 0)
    assert send_weekly_summaries.apply().successful()
