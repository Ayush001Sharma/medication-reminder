from datetime import time, timedelta

from django.shortcuts import get_object_or_404, render
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from accounts.permissions import IsPatient
from config.ratelimit import DoseLinkThrottle
from medications.models import Medication
from medications.utils import patient_timezone

from . import dose_actions, links
from .models import DoseEvent, DoseStatus, Schedule
from .serializers import DoseSerializer, ScheduleSerializer
from .services import local_to_utc

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


# --- Dose actions (patient-facing API) -----------------------------------------
UPCOMING_DEFAULT_DAYS, UPCOMING_MAX_DAYS = 7, 30


def local_day_window(user, now):
    """UTC bounds ``[start, end)`` of the patient's current local day.

    Built from local midnights, so a 23- or 25-hour DST day is handled.
    """
    tz = patient_timezone(user)
    today = now.astimezone(tz).date()
    return (
        local_to_utc(today, time.min, tz),
        local_to_utc(today + timedelta(days=1), time.min, tz),
    )


class DoseViewSet(viewsets.GenericViewSet):
    """The patient's own doses. Another patient's dose id is a 404.

    * ``GET today/``: every dose scheduled during the patient's local day.
    * ``GET upcoming/?days=7``: pending/reminded doses from now on (1-30 days).
    * ``POST {id}/taken/``: mark taken (a missed dose becomes ``taken_late``).
    * ``POST {id}/skip/``: mark skipped.
    Repeating an action returns the same dose unchanged (200). A status that
    does not allow the action returns 409.
    """

    serializer_class = DoseSerializer
    permission_classes = [IsPatient]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return DoseEvent.objects.none()
        return DoseEvent.objects.filter(patient=self.request.user).select_related("medication")

    @extend_schema(responses=DoseSerializer(many=True))
    @action(detail=False, methods=["get"])
    def today(self, request):
        start, end = local_day_window(request.user, timezone.now())
        doses = self.get_queryset().filter(scheduled_at__gte=start, scheduled_at__lt=end)
        return Response(self.get_serializer(doses, many=True).data)

    @extend_schema(
        parameters=[OpenApiParameter("days", int, description="1-30, default 7")],
        responses=DoseSerializer(many=True),
    )
    @action(detail=False, methods=["get"])
    def upcoming(self, request):
        raw = request.query_params.get("days", UPCOMING_DEFAULT_DAYS)
        try:
            days = int(raw)
        except (TypeError, ValueError):
            days = 0
        if not 1 <= days <= UPCOMING_MAX_DAYS:
            raise ValidationError({"days": f"Must be a whole number from 1 to {UPCOMING_MAX_DAYS}."})
        now = timezone.now()
        doses = self.get_queryset().filter(
            status__in=[DoseStatus.PENDING, DoseStatus.REMINDED],
            scheduled_at__gte=now, scheduled_at__lt=now + timedelta(days=days),
        )
        return Response(self.get_serializer(doses, many=True).data)

    @extend_schema(request=None, responses=DoseSerializer)
    @action(detail=True, methods=["post"])
    def taken(self, request, pk=None):
        return self._act(request, pk, dose_actions.mark_taken)

    @extend_schema(request=None, responses=DoseSerializer)
    @action(detail=True, methods=["post"])
    def skip(self, request, pk=None):
        return self._act(request, pk, dose_actions.mark_skipped)

    def _act(self, request, pk, action_fn):
        dose = self.get_object()  # 404 unless it belongs to this patient
        try:
            dose, _changed = action_fn(dose.pk, request.user.pk)
        except dose_actions.DoseConflict as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        return Response(self.get_serializer(dose).data)


# --- One-click link from the reminder email (no login) -------------------------
PAGE_STATUS = {"ok": 200, "invalid": 400, "expired": 410, "conflict": 409, "missing": 404, "throttled": 429}


def _page(request, state, message="", dose=None, can_confirm=False):
    """Render the minimal confirmation page. Never cached: the URL holds a credential."""
    local = None
    if dose is not None:
        local = dose.scheduled_at.astimezone(patient_timezone(dose.patient))
    response = render(
        request, "scheduling/dose_link.html",
        {"state": state, "message": message, "dose": dose, "local": local, "can_confirm": can_confirm},
        status=PAGE_STATUS[state],
    )
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer"
    response["X-Robots-Tag"] = "noindex"
    return response


# The signed token in the URL is the credential and there is no session or
# cookie to ride on, so CSRF protection has nothing to protect here.
@csrf_exempt
@require_http_methods(["GET", "HEAD", "POST"])
def dose_link(request, token):
    """Confirmation page (GET, read-only) and the actual change (POST).

    GET never writes: mail scanners and link previews prefetch URLs. The page
    shows a button; only its POST marks the dose taken. Rate limited per client
    address (429 with Retry-After), before the token is even checked.
    """
    throttle = DoseLinkThrottle()
    if not throttle.allow_request(request, None):
        response = _page(request, "throttled", "Too many requests. Please wait a minute and try again.")
        response["Retry-After"] = str(int(throttle.wait() or 60))
        return response
    try:
        dose_id, patient_id = links.read_token(token)
    except links.LinkExpired:
        return _page(request, "expired", "This link has expired. Open the app to record your dose.")
    except links.LinkInvalid:
        return _page(request, "invalid", "This link is not valid.")

    if request.method == "POST":
        return _confirm(request, dose_id, patient_id)

    dose = (
        DoseEvent.objects.select_related("medication", "patient__patient_profile")
        .filter(pk=dose_id, patient_id=patient_id).first()
    )
    if dose is None:
        return _page(request, "missing", "This dose no longer exists.")
    return _page(request, "ok", dose=dose, can_confirm=dose.status in dose_actions.TAKEABLE - {DoseStatus.TAKEN})


def _confirm(request, dose_id, patient_id):
    try:
        dose, changed = dose_actions.mark_taken(dose_id, patient_id)
    except DoseEvent.DoesNotExist:
        return _page(request, "missing", "This dose no longer exists.")
    except dose_actions.DoseConflict as exc:
        dose = DoseEvent.objects.select_related("medication", "patient__patient_profile").get(pk=dose_id)
        return _page(request, "conflict", str(exc), dose=dose)
    dose = DoseEvent.objects.select_related("medication", "patient__patient_profile").get(pk=dose.pk)
    note = "Recorded. Thank you." if changed else "Already recorded. Nothing changed."
    return _page(request, "ok", note, dose=dose)
