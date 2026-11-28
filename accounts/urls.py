from django.urls import path
from rest_framework_simplejwt.views import TokenRefreshView

from . import access_views, views

urlpatterns = [
    path("auth/register/", views.RegisterView.as_view(), name="register"),
    path("auth/login/", views.LoginView.as_view(), name="login"),
    path("auth/refresh/", TokenRefreshView.as_view(), name="token-refresh"),
    path("me/", views.MeView.as_view(), name="me"),
    # Access sharing
    path("access/grants/", access_views.GrantListCreateView.as_view(), name="grant-list"),
    path("access/grants/<int:pk>/revoke/", access_views.GrantRevokeView.as_view(), name="grant-revoke"),
    path("access/invitations/", access_views.InvitationListView.as_view(), name="invitation-list"),
    path("access/invitations/<int:pk>/accept/", access_views.InvitationAcceptView.as_view(), name="invitation-accept"),
    path("patients/", access_views.AccessiblePatientListView.as_view(), name="accessible-patients"),
]
