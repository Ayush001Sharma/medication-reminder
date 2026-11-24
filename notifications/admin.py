from django.contrib import admin

from .models import NotificationLog


@admin.register(NotificationLog)
class NotificationLogAdmin(admin.ModelAdmin):
    list_display = ["id", "dose_event", "channel", "status", "attempts", "sent_at"]
    list_filter = ["status", "channel"]
    readonly_fields = [f.name for f in NotificationLog._meta.fields]
