from drf_spectacular.utils import extend_schema
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from accounts.permissions import IsPatient

from .models import Medication
from .serializers import MedicationSerializer


class MedicationViewSet(viewsets.ModelViewSet):
    """A patient's own medications. Other patients' records are invisible (404).

    There is no DELETE: medications are deactivated so dose history is kept.
    Filter with ``?active=true|false``.
    """

    serializer_class = MedicationSerializer
    permission_classes = [IsPatient]
    http_method_names = ["get", "post", "patch", "head", "options"]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Medication.objects.none()
        qs = Medication.objects.filter(patient=self.request.user)
        active = self.request.query_params.get("active")
        if active is not None:
            qs = qs.filter(is_active=active.lower() == "true")
        return qs

    def perform_create(self, serializer):
        serializer.save(patient=self.request.user)

    @extend_schema(request=None, responses=MedicationSerializer)
    @action(detail=True, methods=["post"])
    def deactivate(self, request, pk=None):
        """Stop a medication (no new reminders); history is preserved."""
        medication = self.get_object()
        medication.is_active = False
        medication.save(update_fields=["is_active", "updated_at"])
        return Response(self.get_serializer(medication).data, status=status.HTTP_200_OK)
