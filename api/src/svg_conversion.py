import math

from svgpathtools import Path, parse_path


def subpath_depths(path: Path) -> list[tuple[Path, int]]:
    subpaths = path.continuous_subpaths()
    depths = []
    for i, subpath in enumerate(subpaths):
        depth = 0
        if subpath.isclosed():
            for j, other in enumerate(subpaths):
                if i == j or not other.isclosed():
                    continue
                try:
                    if subpath.is_contained_by(other):
                        depth += 1
                except (AssertionError, ValueError):
                    continue
        depths.append(depth)
    return list(zip(subpaths, depths))


def convert_evenodd_to_nonzero(d: str) -> str:
    path = parse_path(d)
    segments = []
    for subpath, depth in subpath_depths(path):
        desired_sign = 1 if depth % 2 == 0 else -1
        actual_sign = 1 if subpath.area() >= 0 else -1
        if subpath.isclosed() and actual_sign * desired_sign < 0:
            subpath = subpath.reversed()
        segments.extend(subpath)
    return Path(*segments).d()


def winding_number(path: Path, point: complex, samples: int = 32) -> float:
    px, py = point.real, point.imag
    total = 0.0
    for segment in path:
        prev = segment.point(0.0)
        dx0 = prev.real - px
        dy0 = prev.imag - py
        for k in range(1, samples + 1):
            cur = segment.point(k / samples)
            dx1 = cur.real - px
            dy1 = cur.imag - py
            cross = dx0 * dy1 - dy0 * dx1
            dot = dx0 * dx1 + dy0 * dy1
            total += math.atan2(cross, dot)
            dx0, dy0 = dx1, dy1
    return total / (2 * math.pi)


def render_compare(original_d: str, converted_d: str, grid: int = 24) -> int:
    original = parse_path(original_d)
    converted = parse_path(converted_d)
    xmin, xmax, ymin, ymax = original.bbox()
    if xmax <= xmin or ymax <= ymin:
        return 0

    mismatches = 0
    for i in range(grid):
        x = xmin + (xmax - xmin) * (i + 0.5) / grid
        for j in range(grid):
            y = ymin + (ymax - ymin) * (j + 0.5) / grid
            point = complex(x, y)
            original_filled = round(winding_number(original, point)) % 2 != 0
            converted_filled = round(winding_number(converted, point)) != 0
            if original_filled != converted_filled:
                mismatches += 1
    return mismatches
