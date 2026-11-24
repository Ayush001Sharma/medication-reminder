#!/usr/bin/env python
"""Confirm the Redis connection configured via REDIS_URL works.

Usage: python scripts/check_redis.py
"""
import os
import sys
from pathlib import Path

import redis
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config.env import normalize_redis_url  # noqa: E402

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
url = os.environ.get("REDIS_URL")
if not url:
    sys.exit("REDIS_URL is not set. Copy .env.example to .env first.")

client = redis.Redis.from_url(normalize_redis_url(url), socket_connect_timeout=3)
client.set("medreminder:check", "ok", ex=10)
assert client.get("medreminder:check") == b"ok"
print("Redis OK: ping=%s, set/get round trip works" % client.ping())
