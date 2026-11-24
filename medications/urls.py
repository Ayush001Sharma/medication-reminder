from django.urls import include, path
from rest_framework.routers import DefaultRouter

from scheduling.views import ScheduleViewSet

from .views import MedicationViewSet

router = DefaultRouter()
router.register("medications", MedicationViewSet, basename="medication")

urlpatterns = [
    path("", include(router.urls)),
    path(
        "medications/<int:medication_pk>/schedules/",
        ScheduleViewSet.as_view({"get": "list", "post": "create"}),
        name="schedule-list",
    ),
    path(
        "medications/<int:medication_pk>/schedules/<int:pk>/",
        ScheduleViewSet.as_view({"get": "retrieve", "patch": "partial_update", "delete": "destroy"}),
        name="schedule-detail",
    ),
]
