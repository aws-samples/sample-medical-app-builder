"""
A small, deliberate SVG diagram builder: boxes on an explicit grid, groups, orthogonal connectors.
Auto-layout engines make architecture diagrams that read like spaghetti; for a document we want the
layout a designer would draw. Every diagram is a short script that places its boxes and names the
edges; the builder only draws.

Fonts: Lato (falls back to Segoe UI / Helvetica). PNGs are rendered from the SVG in headless Chromium.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from xml.sax.saxutils import escape

FONT = "Lato, 'Segoe UI', Helvetica, Arial, sans-serif"

INK = "#1F2933"
MUTED = "#5B6770"
LINE = "#5B6770"
GREEN = "#0F7B5F"
BLUE = "#2F6FB2"
AMBER = "#B7791F"

PALETTE = {
    "grey": ("#F4F6F8", "#D9E1E7"),
    "green": ("#EEF6F3", "#BFDCD1"),
    "warm": ("#FFF9F0", "#F0DDB8"),
    "blue": ("#F1F3F9", "#C9D1E6"),
    "white": ("#FFFFFF", "#E3D5B8"),
    "violet": ("#F5F1FA", "#D9CCEA"),
}


def text_width(s: str, size: float) -> float:
    """Rough Lato width; enough for label backgrounds."""
    return len(s) * size * 0.53


@dataclass
class Box:
    id: str
    x: float
    y: float
    w: float
    h: float
    title: str
    desc: list[str] = field(default_factory=list)
    kind: str = "box"  # box | store | person | note
    fill: str = "#FFFFFF"
    stroke: str = LINE
    title_size: float = 12.5
    desc_size: float = 9.6
    dashed: bool = False

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    def anchor(self, side: str, at: float | None = None) -> tuple[float, float]:
        """A point on a side: 'l','r','t','b'; `at` is an absolute coordinate along that side (default centre)."""
        if side == "l":
            return (self.x, at if at is not None else self.cy)
        if side == "r":
            return (self.x + self.w, at if at is not None else self.cy)
        if side == "t":
            return (at if at is not None else self.cx, self.y)
        if side == "b":
            return (at if at is not None else self.cx, self.y + self.h)
        raise ValueError(side)


class Diagram:
    def __init__(self, width: float, height: float, title: str, subtitle: str | None = None):
        self.w = width
        self.h = height
        self.title = title
        self.subtitle = subtitle
        self.boxes: dict[str, Box] = {}
        self.parts: list[str] = []
        self.edge_parts: list[str] = []
        self.label_parts: list[str] = []
        self._markers: set[str] = set()

    # ── shapes ────────────────────────────────────────────────────────────────

    def group(self, x: float, y: float, w: float, h: float, title: str, palette: str = "grey", title_size: float = 12, sub: str | None = None) -> None:
        fill, stroke = PALETTE[palette]
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" ry="10" fill="{fill}" stroke="{stroke}" stroke-width="1.2"/>')
        self.parts.append(f'<text x="{x + 14}" y="{y + 22}" font-family="{FONT}" font-size="{title_size}" font-weight="700" fill="{INK}">{escape(title)}</text>')
        if sub:
            self.parts.append(f'<text x="{x + 14}" y="{y + 22 + title_size + 2}" font-family="{FONT}" font-size="9.5" fill="{MUTED}">{escape(sub)}</text>')

    def box(self, b: Box) -> Box:
        self.boxes[b.id] = b
        dash = ' stroke-dasharray="5 4"' if b.dashed else ""
        if b.kind == "store":
            # A cylinder: body + top ellipse.
            ry = 7
            self.parts.append(
                f'<path d="M{b.x},{b.y + ry} a{b.w / 2},{ry} 0 0 1 {b.w},0 v{b.h - 2 * ry} a{b.w / 2},{ry} 0 0 1 -{b.w},0 z" fill="{b.fill}" stroke="{b.stroke}" stroke-width="1.2"{dash}/>'
            )
            self.parts.append(f'<path d="M{b.x},{b.y + ry} a{b.w / 2},{ry} 0 0 0 {b.w},0" fill="none" stroke="{b.stroke}" stroke-width="1.2"/>')
            text_top = b.y + ry + 2
        elif b.kind == "person":
            self.parts.append(f'<rect x="{b.x}" y="{b.y}" width="{b.w}" height="{b.h}" rx="22" ry="22" fill="{b.fill}" stroke="{b.stroke}" stroke-width="1.2"{dash}/>')
            # a small person glyph on the left
            gx, gy = b.x + 20, b.cy
            self.parts.append(f'<circle cx="{gx}" cy="{gy - 8}" r="5" fill="none" stroke="{b.stroke}" stroke-width="1.4"/>')
            self.parts.append(f'<path d="M{gx - 9},{gy + 10} a9,9 0 0 1 18,0" fill="none" stroke="{b.stroke}" stroke-width="1.4"/>')
            text_top = b.y
        else:
            self.parts.append(f'<rect x="{b.x}" y="{b.y}" width="{b.w}" height="{b.h}" rx="8" ry="8" fill="{b.fill}" stroke="{b.stroke}" stroke-width="1.2"{dash}/>')
            text_top = b.y
        # Text block, vertically centred.
        lines = [(b.title, b.title_size, 700, INK)] + [(d, b.desc_size, 400, MUTED) for d in b.desc]
        gap = 3
        total = sum(sz for _, sz, _, _ in lines) + gap * (len(lines) - 1)
        y = text_top + (b.h - (text_top - b.y)) / 2 - total / 2
        x_text = b.x + b.w / 2 + (12 if b.kind == "person" else 0)
        for s, sz, weight, colour in lines:
            y += sz
            self.parts.append(f'<text x="{x_text}" y="{y - 1}" text-anchor="middle" font-family="{FONT}" font-size="{sz}" font-weight="{weight}" fill="{colour}">{escape(s)}</text>')
            y += gap
        return b

    def note(self, x: float, y: float, text: str, size: float = 9.5, colour: str = MUTED, anchor: str = "start", weight: int = 400) -> None:
        self.label_parts.append(f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" fill="{colour}">{escape(text)}</text>')

    # ── connectors ────────────────────────────────────────────────────────────

    def edge(self, points: list[tuple[float, float]], colour: str = LINE, dashed: bool = False, label: str | None = None, label_at: tuple[float, float] | None = None, arrow: bool = True, width: float = 1.3, label_colour: str | None = None) -> None:
        d = "M" + " L".join(f"{x},{y}" for x, y in points)
        dash = ' stroke-dasharray="6 4"' if dashed else ""
        marker = f' marker-end="url(#arrow-{colour.lstrip("#")})"' if arrow else ""
        self.edge_parts.append(f'<path d="{d}" fill="none" stroke="{colour}" stroke-width="{width}"{dash}{marker} stroke-linejoin="round"/>')
        self._markers.add(colour)
        if label:
            if label_at is None:
                # midpoint of the longest segment
                best = max(range(len(points) - 1), key=lambda i: abs(points[i + 1][0] - points[i][0]) + abs(points[i + 1][1] - points[i][1]))
                (x1, y1), (x2, y2) = points[best], points[best + 1]
                label_at = ((x1 + x2) / 2, (y1 + y2) / 2 - 6 if y1 == y2 else (y1 + y2) / 2)
            lx, ly = label_at
            size = 9.2
            tw = text_width(label, size) + 8
            self.label_parts.append(f'<rect x="{lx - tw / 2}" y="{ly - size}" width="{tw}" height="{size + 5}" fill="white" fill-opacity="0.92" rx="3"/>')
            self.label_parts.append(f'<text x="{lx}" y="{ly}" text-anchor="middle" font-family="{FONT}" font-size="{size}" fill="{label_colour or colour}">{escape(label)}</text>')

    def connect(self, a: str, side_a: str, b: str, side_b: str, colour: str = LINE, dashed: bool = False, label: str | None = None, via: float | None = None, at_a: float | None = None, at_b: float | None = None, label_at: tuple[float, float] | None = None) -> None:
        """Orthogonal connector between two box sides. `via` fixes the coordinate of the middle segment
        (x for horizontal runs, y for vertical ones); default = halfway."""
        pa = self.boxes[a].anchor(side_a, at_a)
        pb = self.boxes[b].anchor(side_b, at_b)
        pts = self._route(pa, side_a, pb, side_b, via)
        self.edge(pts, colour=colour, dashed=dashed, label=label, label_at=label_at)

    @staticmethod
    def _route(pa: tuple[float, float], sa: str, pb: tuple[float, float], sb: str, via: float | None) -> list[tuple[float, float]]:
        (ax, ay), (bx, by) = pa, pb
        horizontal_a = sa in ("l", "r")
        horizontal_b = sb in ("l", "r")
        if horizontal_a and horizontal_b:
            if abs(ay - by) < 0.5:
                return [pa, pb]
            mx = via if via is not None else (ax + bx) / 2
            return [pa, (mx, ay), (mx, by), pb]
        if not horizontal_a and not horizontal_b:
            if abs(ax - bx) < 0.5:
                return [pa, pb]
            my = via if via is not None else (ay + by) / 2
            return [pa, (ax, my), (bx, my), pb]
        if horizontal_a and not horizontal_b:
            return [pa, (bx, ay), pb]
        return [pa, (ax, by), pb]

    # ── output ────────────────────────────────────────────────────────────────

    def render(self) -> str:
        defs = []
        for colour in sorted(self._markers):
            cid = colour.lstrip("#")
            defs.append(f'<marker id="arrow-{cid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{colour}"/></marker>')
        head = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}">',
            "<defs>" + "".join(defs) + "</defs>",
            f'<rect width="{self.w}" height="{self.h}" fill="white"/>',
            f'<text x="30" y="40" font-family="{FONT}" font-size="20" font-weight="700" fill="{INK}">{escape(self.title)}</text>',
        ]
        if self.subtitle:
            head.append(f'<text x="30" y="62" font-family="{FONT}" font-size="11" fill="{MUTED}">{escape(self.subtitle)}</text>')
        return "\n".join(head + self.parts + self.edge_parts + self.label_parts + ["</svg>"])


def legend(d: Diagram, x: float, y: float, items: list[tuple[str, str, bool]]) -> None:
    """items: (colour, text, dashed)"""
    for i, (colour, text, dashed) in enumerate(items):
        yy = y + i * 18
        dash = ' stroke-dasharray="6 4"' if dashed else ""
        d.label_parts.append(f'<line x1="{x}" y1="{yy - 4}" x2="{x + 34}" y2="{yy - 4}" stroke="{colour}" stroke-width="1.6"{dash}/>')
        d.label_parts.append(f'<text x="{x + 42}" y="{yy}" font-family="{FONT}" font-size="9.8" fill="{MUTED}">{escape(text)}</text>')
