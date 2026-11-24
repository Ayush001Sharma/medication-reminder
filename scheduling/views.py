from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import viewsets

from accounts.permissions import IsPatient
from medications.models import Medication

from .models import Schedule
from .serializers import ScheduleSerializer

_medication_param = OpenApiParameter("medication_pk", int, OpenApiParameter.PATH)


@extend_schema_view(
    list=extend_schema(parameters=[_medication_param]),
    create=extend_schema(parameters=[_medication_param]),
    retrieve=extend_schema(parameters=[_medication_param]),
    partial_update=extend_schema(parameters=[_medication_param]),
    destroy=extend_schema(parameters=[_medication_param]),
)
class ScheduleViewSet(viewsets.ModelViewSet):
    """Schedules of one of the patient's own medications."""

    serializer_class = ScheduleSerializer
    permission_classes = [IsPatient]

    def get_medication(self):
        # Scoped to the requesting patient, so someone else's id is a 404.
        return get_object_or_404(
            Medication, pk=self.kwargs["medication_pk"], patient=self.request.user
        )

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Schedule.objects.none()
        return Schedule.objects.filter(medication=self.get_medication())

    def perform_create(self, serializer):
        serializer.save(medication=self.get_medication())
