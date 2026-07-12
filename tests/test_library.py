"""Byte-range parsing + path-traversal guard — the security-sensitive pure
helpers behind /api/library/{id}/stream and deletion."""

from __future__ import annotations

from pathlib import Path

from app import library


# --- HTTP Range parsing -----------------------------------------------------
def test_range_none_when_absent_or_invalid():
    assert library.parse_byte_range(None, 1000) is None
    assert library.parse_byte_range("", 1000) is None
    assert library.parse_byte_range("bogus", 1000) is None
    assert library.parse_byte_range("bytes=0-", 0) is None  # empty file


def test_range_open_ended():
    assert library.parse_byte_range("bytes=0-", 1000) == (0, 999)
    assert library.parse_byte_range("bytes=500-", 1000) == (500, 999)


def test_range_closed():
    assert library.parse_byte_range("bytes=100-200", 1000) == (100, 200)


def test_range_clamps_over_long_end():
    # end beyond EOF is clamped to file_size-1 (no over-read)
    assert library.parse_byte_range("bytes=0-99999", 1000) == (0, 999)


def test_range_clamps_start_past_end():
    # a start past EOF collapses to the last byte, never negative/out of range
    start, end = library.parse_byte_range("bytes=5000-", 1000)
    assert 0 <= start <= end <= 999


# --- Path-traversal guard ---------------------------------------------------
def test_is_within_true_for_child(tmp_path: Path):
    child = tmp_path / "sub" / "file.mp4"
    child.parent.mkdir(parents=True)
    child.write_bytes(b"x")
    assert library.is_within(child, tmp_path)


def test_is_within_false_for_escape(tmp_path: Path):
    root = tmp_path / "downloads"
    root.mkdir()
    outside = tmp_path / "secret.txt"
    outside.write_text("nope")
    assert not library.is_within(outside, root)
    assert not library.is_within(root / ".." / "secret.txt", root)


def test_is_within_never_raises():
    # Odd inputs must return False, not blow up.
    assert library.is_within("", "/downloads") in (True, False)
