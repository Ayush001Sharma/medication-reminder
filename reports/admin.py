from django.contrib import admin

from .models import AuditLog, WeeklySummary


class ReadOnlyAdmin(admin.ModelAdmin):
    """Audit data must not be edited or deleted through the admin."""

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(AuditLog)
class AuditLogAdmin(ReadOnlyAdmin):
    list_display = ["id", "viewer_email", "patient", "action", "range_start", "range_end", "created_at"]
    list_filter = ["action"]


@admin.register(WeeklySummary)
class WeeklySummaryAdmin(ReadOnlyAdmin):
    list_display = ["id", "patient", "recipient", "week_start", "status", "sent_at"]
    list_filter = ["status"]
