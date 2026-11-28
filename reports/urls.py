from django.urls import path

from . import views

urlpatterns = [
    path("reports/adherence/", views.AdherenceReportView.as_view(), name="adherence-report"),
    path("audit-log/", views.AuditLogListView.as_view(), name="audit-log"),
]
