from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.generics import ListAPIView
from rest_framework.pagination import LimitOffsetPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.access import resolve_patient
from accounts.models import Role
from accounts.permissions import IsPatient
from medications.utils import patient_timezone

from . import audit
from .models import AuditLog
from .ranges import parse_query_range
from .serializers import AdherenceReportSerializer, AuditLogSerializer
from .services import adherence_report


class AuditPagination(LimitOffsetPagination):
    default_limit = 50
    max_limit = 200


class AdherenceReportView(APIView):
    """Adherence report for a patient over a local date range (max 366 days).

    Patients read their own report. Caregivers and doctors must pass
    ``patient=<id>`` and need an ACTIVE grant, checked in the database on this
    request; without one the answer is 404. Every caregiver/doctor view is
    written to the audit log before any data is returned.
    """

    permission_classes = [IsAuthenticated]

    @extend_schema(
        parameters=[
            OpenApiParameter("patient", int, description="Required for caregivers and doctors."),
            OpenApiParameter("from", str, description="YYYY-MM-DD, patient's local date. Default: 29 days before 'to'."),
            OpenApiParameter("to", str, description="YYYY-MM-DD, patient's local date, inclusive. Default: today."),
        ],
        responses=AdherenceReportSerializer,
    )
    def get(self, request):
        patient = resolve_patient(request.user, request.query_params.get("patient"))  # 404 / 400
        now = timezone.now()
        rng = parse_query_range(request.query_params, patient_timezone(patient), now)  # 400
        if request.user.pk != patient.pk:
            audit.record_view(request.user, patient, rng)
        return Response(AdherenceReportSerializer(adherence_report(patient, rng, now)).data)


class AuditLogListView(ListAPIView):
    """Patient: who viewed (or was emailed) your adherence data, newest first."""

    permission_classes = [IsPatient]
    serializer_class = AuditLogSerializer
    pagination_class = AuditPagination

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return AuditLog.objects.none()
        return AuditLog.objects.filter(patient=self.request.user)
