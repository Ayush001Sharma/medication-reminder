"""Configuration hygiene: every variable is documented, secrets are checked, nothing real is committed."""
import re
from pathlib import Path

import pytest
from django.core.exceptions import ImproperlyConfigured

from config.env import env_bool, env_int, env_list, require_env, validate_secret_key

ROOT = Path(__file__).resolve().parent.parent
READ_ENV = re.compile(r"""(?:environ\.get|env_int|env_bool|env_list|env_origins|require_env)\(\s*["']([A-Z][A-Z0-9_]+)["']""")
DEV_KEY = "dev-only-insecure-key-change-me-not-for-production-use"


def variables_read_by_the_code() -> set[str]:
    names = set()
    for path in ROOT.rglob("*.py"):
        parts = set(path.relative_to(ROOT).parts)
        if parts & {".venv", "tests", "migrations", "node_modules"} or path.name.startswith("test_") or path.name == "conftest.py":
            continue
        names |= set(READ_ENV.findall(path.read_text(encoding="utf-8")))
    return names


def test_the_scan_finds_the_variables_we_know_about():
    names = variables_read_by_the_code()
    assert {"DATABASE_URL", "REDIS_URL", "DJANGO_SECRET_KEY", "DJANGO_DEBUG", "SITE_BASE_URL", "EMAIL_BACKEND",
            "EMAIL_HOST_PASSWORD", "RATE_LIMIT_LOGIN", "DEMO_PASSWORD"} <= names


def test_every_variable_is_listed_in_env_example_and_the_readme():
    example = (ROOT / ".env.example").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    documented_in_example = set(re.findall(r"^#?\s*([A-Z][A-Z0-9_]+)=", example, re.MULTILINE))
    names = variables_read_by_the_code()
    assert names - documented_in_example == set(), "missing from .env.example"
    assert {n for n in names if n not in readme} == set(), "missing from README.md"
    assert documented_in_example - names == set(), ".env.example lists a variable the code never reads"


def test_env_example_holds_only_placeholders():
    example = (ROOT / ".env.example").read_text(encoding="utf-8")
    assert "DB_PASSWORD" in example and "smtp-password-placeholder" in example
    for line in example.splitlines():
        if line.startswith(("DATABASE_URL", "REDIS_URL")):
            assert "@localhost" in line or "localhost" in line  # nothing pointing at a real host
    assert not re.search(r"(sk_live|AKIA[0-9A-Z]{12,}|-----BEGIN)", example)


def test_env_files_are_ignored_by_git():
    ignored = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert ".env" in ignored


# --- helpers ------------------------------------------------------------------------------------
def test_require_env_reports_the_variable_name(monkeypatch):
    monkeypatch.delenv("NOT_SET_ANYWHERE", raising=False)
    with pytest.raises(ImproperlyConfigured, match="NOT_SET_ANYWHERE"):
        require_env("NOT_SET_ANYWHERE")
    monkeypatch.setenv("NOT_SET_ANYWHERE", "  value  ")
    assert require_env("NOT_SET_ANYWHERE") == "value"


def test_env_int(monkeypatch):
    monkeypatch.delenv("SOME_INT", raising=False)
    assert env_int("SOME_INT", 7) == 7
    monkeypatch.setenv("SOME_INT", "12")
    assert env_int("SOME_INT", 7) == 12
    monkeypatch.setenv("SOME_INT", "twelve")
    with pytest.raises(ImproperlyConfigured, match="SOME_INT"):
        env_int("SOME_INT", 7)


@pytest.mark.parametrize("raw,expected", [("true", True), ("1", True), ("YES", True), ("on", True),
                                          ("false", False), ("0", False), ("No", False), ("off", False), ("", True)])
def test_env_bool(monkeypatch, raw, expected):
    monkeypatch.setenv("SOME_FLAG", raw)
    assert env_bool("SOME_FLAG", True) is expected


def test_env_bool_rejects_nonsense_and_uses_default_when_unset(monkeypatch):
    monkeypatch.setenv("SOME_FLAG", "maybe")
    with pytest.raises(ImproperlyConfigured, match="SOME_FLAG"):
        env_bool("SOME_FLAG", True)
    monkeypatch.delenv("SOME_FLAG")
    assert env_bool("SOME_FLAG", False) is False


def test_env_list(monkeypatch):
    monkeypatch.setenv("SOME_LIST", " a, b ,,c ")
    assert env_list("SOME_LIST", "x") == ["a", "b", "c"]
    monkeypatch.delenv("SOME_LIST")
    assert env_list("SOME_LIST", "x,y") == ["x", "y"]


# --- secret key ---------------------------------------------------------------------------------
@pytest.mark.parametrize("key", [DEV_KEY, "change-me-in-production", "CHANGE-ME-long-enough-value-123456789012", "short"])
def test_weak_keys_are_rejected_outside_debug(key):
    with pytest.raises(ImproperlyConfigured, match="DJANGO_SECRET_KEY"):
        validate_secret_key(key, debug=False, dev_key=DEV_KEY)


def test_strong_keys_are_accepted_and_debug_accepts_anything():
    validate_secret_key("x" * 32, debug=False, dev_key=DEV_KEY)
    validate_secret_key(DEV_KEY, debug=True, dev_key=DEV_KEY)
    validate_secret_key("change-me", debug=True, dev_key=DEV_KEY)


# --- .env files written by Windows tools --------------------------------------------------------
def test_env_file_with_bom_and_windows_line_endings_is_read(tmp_path, monkeypatch):
    from config.env import load_env_file
    monkeypatch.delenv("FROM_WINDOWS_A", raising=False)
    monkeypatch.delenv("FROM_WINDOWS_B", raising=False)
    path = tmp_path / ".env"
    path.write_bytes(b"\xef\xbb\xbfFROM_WINDOWS_A=one\r\nFROM_WINDOWS_B=two\r\n")  # Notepad: UTF-8 with BOM + CRLF
    load_env_file(path)
    import os
    assert (os.environ["FROM_WINDOWS_A"], os.environ["FROM_WINDOWS_B"]) == ("one", "two")


def test_real_environment_variables_beat_the_env_file(tmp_path, monkeypatch):
    from config.env import load_env_file
    monkeypatch.setenv("FROM_WINDOWS_A", "from-the-shell")
    path = tmp_path / ".env"
    path.write_text("FROM_WINDOWS_A=from-the-file\n", encoding="utf-8")
    load_env_file(path)
    import os
    assert os.environ["FROM_WINDOWS_A"] == "from-the-shell"


def test_missing_env_file_is_fine(tmp_path):
    from config.env import load_env_file
    load_env_file(tmp_path / "does-not-exist.env")


def test_utf16_env_file_from_powershell_gets_a_helpful_error(tmp_path):
    from config.env import load_env_file
    path = tmp_path / ".env"
    path.write_bytes("DATABASE_URL=postgres://u:p@localhost/x\r\n".encode("utf-16"))  # what `echo ... > .env` writes
    with pytest.raises(ImproperlyConfigured, match="UTF-8.*Copy-Item"):
        load_env_file(path)
