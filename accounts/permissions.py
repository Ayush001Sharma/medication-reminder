"""Reusable role-based DRF permission classes."""
from rest_framework.permissions import BasePermission

from .models import Role


class HasRole(BasePermission):
    """Base class: the request user must be authenticated with ``role``."""

    role: str = ""

    def has_permission(self, request, view):
        user = request.user
        return bool(user and user.is_authenticated and user.role == self.role)


class IsPatient(HasRole):
    role = Role.PATIENT


class IsCaregiver(HasRole):
    role = Role.CAREGIVER


class IsDoctor(HasRole):
    role = Role.DOCTOR


class IsGrantee(BasePermission):
    """Caregivers and doctors: the roles that can be granted access to a patient."""

    def has_permission(self, request, view):
        user = request.user
        return bool(
            user and user.is_authenticated and user.role in (Role.CAREGIVER, Role.DOCTOR)
        )
