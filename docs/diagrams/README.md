# Architecture diagrams

The diagrams of the README and the design documents, drawn deliberately (explicit layout, not auto-layout) so they read
like slides: `platform-overview` (every component of one hospital deployment and the two flows through
them), `frontend` (the panel: pages, the verified core, the clients) and `app-creator` (the drafting agent
and the authoring plumbing).

| File | Use |
|---|---|
| `*.png` | what the README and the documents embed (rendered at 1.5×, Lato) |
| `*.svg` | editable vector; opens in a browser, Inkscape, Illustrator |
| `svgdiagram.py` | the tiny builder: groups, boxes (box / store / person), orthogonal connectors, labels, legend |
| `platform_overview.py`, `frontend.py`, `app_creator.py` | the overview diagrams — coordinates and edges |
| `architecture.py`, `pipeline.py`, `runtime.py` | the as-built deployment (the README's architecture figure), the request-to-app pipeline, the dispatcher's enforcement chain |
| `render_png.py` | SVG → PNG through headless Chromium (Playwright): `python render_png.py x.svg x.png 1.5` |
| `aws-infrastructure.drawio` | the AWS infrastructure as built (ten stacks, the reference and hospital servers, guardrails) with the official AWS architecture icons — open in [app.diagrams.net](https://app.diagrams.net), the draw.io desktop app or the VS Code extension; export PNG/SVG/PDF from there |
| `aws-infrastructure.png` · `render_drawio.py` | the draw.io diagram rendered with the official icons (the README embeds it): `python render_drawio.py aws-infrastructure.drawio aws-infrastructure.png` goes through the diagrams.net viewer in headless Chromium, since the icons are draw.io's shape library — or export from app.diagrams.net by hand |
| `aws_infrastructure_drawio.py` | generates the `.drawio` (mxGraph XML): containers for the AWS cloud, the region, each CDK stack, the reference VPC and the hospital data centre; `mxgraph.aws4` icons; routed connectors; also writes `$TMPDIR/aws-infrastructure-preview.svg`, a plain-box rendering of the same geometry to check the layout without draw.io |

Regenerate after a change: `python3 platform_overview.py` (writes the SVG), then `render_png.py` — or open
the SVG in a browser and export. Any SVG renderer works for the PNG; Chromium is used because it lays out
text exactly as the SVG specifies. The font is Lato with a Segoe UI / Helvetica fallback; keep it when
editing so the boxes keep fitting their text.

## The draw.io infrastructure diagram

`aws-infrastructure.drawio` is generated, so it can be regenerated when a stack changes
(`python3 aws_infrastructure_drawio.py`), but it is also a normal draw.io file: move a box, and its
connectors follow. Connectors carry explicit waypoints; if draw.io routes one differently on your
version, drag the segment once and save. Colours follow the AWS category palette (compute orange,
networking purple, storage green, database magenta, security red, machine learning teal); the
"stretch" items are drawn at 60 % opacity.
