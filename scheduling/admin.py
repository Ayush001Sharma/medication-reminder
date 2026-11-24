from django.contrib import admin

from .models import DoseEvent, Schedule


@admin.register(Schedule)
class ScheduleAdmin(admin.ModelAdmin):
    list_display = ["id", "medication", "times_of_day", "days_of_week", "start_date", "end_date", "is_active"]


@admin.register(DoseEvent)
class DoseEventAdmin(admin.ModelAdmin):
    list_display = ["id", "medication", "patient", "scheduled_at", "status"]
    list_filter = ["status"]
