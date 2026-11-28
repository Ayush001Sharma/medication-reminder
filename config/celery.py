"""Celery application. Tasks are auto-discovered from every installed app."""
import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

app = Celery("config")
# Read CELERY_* settings from Django settings.
app.config_from_object("django.conf:settings", namespace="CELERY")
# Loads tasks.py from all INSTALLED_APPS.
app.autodiscover_tasks()
