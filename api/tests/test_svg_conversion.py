import pytest
from svg_conversion import convert_evenodd_to_nonzero, render_compare

DONUT = "M 0 0 L 100 0 L 100 100 L 0 100 Z M 10 10 L 90 10 L 90 90 L 10 90 Z"
DONUT_REVERSED_HOLE = (
    "M 0 0 L 100 0 L 100 100 L 0 100 Z M 10 10 L 10 90 L 90 90 L 90 10 Z"
)
SQUARE = "M 0 0 L 100 0 L 100 100 L 0 100 Z"
CUBIC_DONUT = (
    "M 50 0 C 77.6 0 100 22.4 100 50 C 100 77.6 77.6 100 50 100 "
    "C 22.4 100 0 77.6 0 50 C 0 22.4 22.4 0 50 0 Z "
    "M 50 30 C 61 30 70 39 70 50 C 70 61 61 70 50 70 C 39 70 30 61 30 50 "
    "C 30 39 39 30 50 30 Z"
)


@pytest.mark.parametrize("path", [DONUT, DONUT_REVERSED_HOLE, SQUARE, CUBIC_DONUT])
def test_conversion_preserves_render_shape(path: str) -> None:
    converted = convert_evenodd_to_nonzero(path)

    assert render_compare(path, converted) == 0


def test_conversion_reverses_odd_depth_subpaths() -> None:
    converted = convert_evenodd_to_nonzero(DONUT)

    assert "M 10.0,10.0 L 10.0,90.0" in converted


def test_conversion_leaves_single_shape_unchanged() -> None:
    assert convert_evenodd_to_nonzero(SQUARE) == (
        "M 0.0,0.0 L 100.0,0.0 L 100.0,100.0 L 0.0,100.0 L 0.0,0.0"
    )


def test_render_compare_detects_distortion() -> None:
    assert render_compare(DONUT, SQUARE) > 0
