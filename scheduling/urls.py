from rest_framework.routers import SimpleRouter

from .views import DoseViewSet

router = SimpleRouter()
router.register("doses", DoseViewSet, basename="dose")

urlpatterns = router.urls
