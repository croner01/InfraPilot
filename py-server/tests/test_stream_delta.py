"""流式思考增量合并：降频但不丢内容（旧实现只发每第 4 个片段）。"""

from __future__ import annotations

from infrapilot.runner import _StreamDeltaCoalescer


def test_coalesces_within_window_without_losing_content():
    now = [0.0]
    out: list[str] = []
    coalescer = _StreamDeltaCoalescer(out.append, min_seconds=0.1, max_chars=1000, clock=lambda: now[0])
    for piece in "abcdefgh":
        coalescer.add(piece)
    assert out == []
    now[0] = 0.2
    coalescer.add("i")
    assert out == ["abcdefghi"]


def test_flushes_when_char_threshold_reached():
    out: list[str] = []
    coalescer = _StreamDeltaCoalescer(out.append, min_seconds=1000, max_chars=5, clock=lambda: 0.0)
    for piece in "abcde":
        coalescer.add(piece)
    assert out == ["abcde"]


def test_final_flush_drains_buffer_and_is_idempotent():
    out: list[str] = []
    coalescer = _StreamDeltaCoalescer(out.append, min_seconds=1000, max_chars=1000)
    coalescer.add("partial")
    assert out == []
    coalescer.flush()
    assert out == ["partial"]
    coalescer.flush()
    assert out == ["partial"]
