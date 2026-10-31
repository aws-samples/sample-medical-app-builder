"""
Analytic phantoms for the synthetic imaging seed — anatomy-like enough to reconstruct and render in three
dimensions, obviously synthetic to anyone who looks.

Every phantom is a function of patient coordinates in millimetres (DICOM LPS: +x towards the patient's left,
+y posterior, +z towards the head) returning stored pixel values, so the same object can be sampled on any
plane: the axial CT series, its coronal reformat, a sagittal T1, an axial FLAIR — all of one body — and a
viewer's MPR and volume rendering see consistent structures wherever they cut. CT values are Hounsfield units
stored with a −1024 intercept (air 0, water 1024); MR values are arbitrary intensities in a 12-bit range, chosen
per sequence so T1, FLAIR, DWI and SWI look like themselves. Radiographs and ultrasound are 2-D images.

Everything is numpy over a meshgrid; a 256×256 slice evaluates in a few milliseconds.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

import numpy as np

Field = Callable[[np.ndarray, np.ndarray, np.ndarray], np.ndarray]  # (x, y, z) in mm → values


@dataclass(frozen=True)
class Anatomy:
    """A phantom: the value field, and the physical extent the series should cover (mm, in x/y/z)."""

    field: Field
    extent: tuple[float, float, float]  # full width (x), depth (y), length (z) in mm
    origin_z: float = 0.0  # z of the bottom slice (mm)


def _ellipsoid(x, y, z, cx, cy, cz, ax, ay, az):
    return ((x - cx) / ax) ** 2 + ((y - cy) / ay) ** 2 + ((z - cz) / az) ** 2 <= 1.0


def _cylinder_z(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def _sphere(x, y, z, cx, cy, cz, r):
    return _ellipsoid(x, y, z, cx, cy, cz, r, r, r)


# ── CT thorax with contrast ──────────────────────────────────────────────────────────────────


def ct_thorax(x, y, z):
    """Trunk with lungs, a contrast-enhanced heart and aorta, spine with vertebrae, a rib cage, a lung nodule."""
    length = 350.0
    taper = 0.82 + 0.18 * np.sin(np.clip(z / length, 0, 1) * math.pi)  # narrower at the shoulders and the diaphragm
    a, b = 165.0 * taper, 118.0 * taper
    rho = np.sqrt((x / a) ** 2 + ((y - 5.0) / b) ** 2)  # 1.0 at the skin
    hu = np.full(x.shape, -1024.0)
    body = rho <= 1.0
    hu[body] = 40.0  # soft tissue
    hu[body & (rho > 0.9)] = -95.0  # subcutaneous fat
    # Lungs: two ellipsoids, air with a faint parenchymal texture.
    lungs = _ellipsoid(x, y, z, -68, -12, 185, 62, 80, 125) | _ellipsoid(x, y, z, 70, -12, 185, 60, 80, 125)
    heart = _sphere(x, y, z, -22, -8, 160, 52)
    lungs &= ~heart
    hu[lungs] = -830.0
    # Bronchi and trachea: air tubes.
    trachea = _cylinder_z(x, y, 0, -40, 9) & (z > 235)
    bronchi = (_cylinder_z(x, y, -32, -35, 6) | _cylinder_z(x, y, 34, -35, 6)) & (z > 175) & (z <= 240)
    hu[trachea | bronchi] = -1000.0
    # Heart with contrast-filled chambers, ascending/descending aorta with contrast.
    hu[heart] = 70.0
    chambers = _sphere(x, y, z, -30, -10, 160, 30) | _sphere(x, y, z, 2, -20, 165, 22)
    hu[chambers] = 260.0
    aorta = _cylinder_z(x, y, 6, 38, 14) & (z > 80)
    arch = _sphere(x, y, z, -5, 10, 238, 30) & ~_sphere(x, y, z, -5, 10, 238, 18) & (y < 40)
    hu[aorta | arch] = 320.0
    # Spine: vertebral bodies with disc spaces, a spinal canal.
    spine = _cylinder_z(x, y, 0, 88, 17)
    disc = (np.mod(z, 26.0) < 5.0)
    hu[spine] = 620.0
    hu[spine & disc] = 260.0
    canal = _cylinder_z(x, y, 0, 88, 6)
    hu[canal] = 25.0
    posterior_elements = _cylinder_z(x, y, 0, 108, 9) & ~disc
    hu[posterior_elements] = 560.0
    # Rib cage: a thin shell just under the fat, in bands, open anteriorly except for the sternum.
    shell = (rho > 0.80) & (rho <= 0.86)
    bands = np.mod(z + 6.0, 24.0) < 8.0
    anterior_gap = (y < -30) & (np.abs(x) > 18)
    ribs = shell & bands & ~anterior_gap & (z > 55) & (z < 320)
    sternum = shell & (np.abs(x) <= 18) & (y < -30) & (z > 120) & (z < 300)
    hu[ribs | sternum] = 520.0
    # A solid pulmonary nodule and a couple of calcified granulomas.
    hu[_sphere(x, y, z, 78, -32, 205, 11)] = 55.0
    hu[_sphere(x, y, z, -60, 20, 130, 4)] = 400.0
    hu[_sphere(x, y, z, 55, -5, 250, 3)] = 400.0
    return hu


CT_THORAX = Anatomy(field=ct_thorax, extent=(380.0, 280.0, 350.0))


# ── CT abdomen, native ───────────────────────────────────────────────────────────────────────


def ct_abdomen(x, y, z):
    """Abdomen and pelvis without contrast: liver, spleen, kidneys, bladder, spine and pelvis, bowel gas."""
    length = 630.0
    taper = 0.86 + 0.14 * np.sin(np.clip(z / length, 0, 1) * math.pi)
    a, b = 178.0 * taper, 128.0 * taper
    rho = np.sqrt((x / a) ** 2 + ((y - 8.0) / b) ** 2)
    hu = np.full(x.shape, -1024.0)
    body = rho <= 1.0
    hu[body] = 35.0
    hu[body & (rho > 0.86)] = -100.0
    hu[_ellipsoid(x, y, z, 62, 5, 470, 92, 72, 95)] = 58.0  # liver
    hu[_ellipsoid(x, y, z, -98, 32, 480, 34, 30, 48)] = 48.0  # spleen
    for side in (-1, 1):
        hu[_ellipsoid(x, y, z, side * 66, 62, 400, 30, 22, 52)] = 38.0  # kidneys
        hu[_ellipsoid(x, y, z, side * 60, 60, 400, 12, 8, 26)] = 12.0  # renal pelvis
    hu[_sphere(x, y, z, 0, -25, 110, 42)] = 12.0  # bladder
    spine = _cylinder_z(x, y, 0, 92, 18)
    disc = (np.mod(z, 30.0) < 6.0)
    hu[spine] = 600.0
    hu[spine & disc] = 250.0
    hu[_cylinder_z(x, y, 0, 92, 6)] = 25.0
    hu[_cylinder_z(x, y, 0, 114, 10) & ~disc] = 540.0
    # The lower ribs over the upper abdomen: a shell just under the fat, in bands, open at the costal margin.
    shell = (rho > 0.80) & (rho <= 0.86)
    bands = np.mod(z + 6.0, 24.0) < 8.0
    costal_margin = (y < -20) & (np.abs(x) < 40 + 0.6 * np.clip(z - 480, 0, 150))
    hu[shell & bands & ~costal_margin & (z > 470)] = 520.0
    # Pelvis: iliac wings flaring to the skin at the crests, a sacrum, the femoral heads in their sockets.
    wings = (z < 230) & (z > 80) & (rho > 0.58) & (rho <= 0.84 - 0.10 * np.clip((230 - z) / 150, 0, 1)) & (y > -10 - 0.4 * np.clip(z - 80, 0, 150))
    hu[wings] = 480.0
    hu[(z < 190) & (z > 40) & _cylinder_z(x, y, 0, 95, 26)] = 470.0
    for side in (-1, 1):
        hu[_sphere(x, y, z, side * 78, 18, 90, 24)] = 500.0  # femoral heads
        hu[_sphere(x, y, z, side * 78, 18, 90, 12)] = 180.0  # their marrow
    # Bowel gas pockets, deterministic.
    rng = np.random.default_rng(7)
    for _ in range(14):
        cx, cy, cz, r = rng.uniform(-90, 90), rng.uniform(-70, 40), rng.uniform(150, 520), rng.uniform(9, 22)
        hu[_sphere(x, y, z, cx, cy, cz, r) & body] = -880.0
    return hu


CT_ABDOMEN = Anatomy(field=ct_abdomen, extent=(400.0, 300.0, 630.0))


# ── MR head ──────────────────────────────────────────────────────────────────────────────────


def _head_tissues(x, y, z):
    """Which tissue each point belongs to: 0 air, 1 scalp, 2 skull, 3 grey, 4 white, 5 CSF, 6 lesion, 7 eye, 8 vein."""
    tissue = np.zeros(x.shape, dtype=np.int8)
    head = _ellipsoid(x, y, z, 0, 8, 0, 78, 96, 88)
    skull_inner = _ellipsoid(x, y, z, 0, 8, 0, 68, 86, 78)
    brain = _ellipsoid(x, y, z, 0, 8, 0, 64, 82, 74)
    white = _ellipsoid(x, y, z, 0, 8, -4, 50, 66, 58)
    tissue[head] = 1
    tissue[skull_inner] = 2
    tissue[brain] = 3
    tissue[white] = 4
    for side in (-1, 1):
        tissue[_ellipsoid(x, y, z, side * 14, 6, 6, 9, 30, 13)] = 5  # lateral ventricles
    tissue[_ellipsoid(x, y, z, 0, 14, -14, 4, 12, 8)] = 5  # third ventricle
    sulci = (np.sin(x / 6.0) * np.sin(y / 7.0) * np.sin(z / 6.5) > 0.55) & brain & ~white
    tissue[sulci] = 5
    tissue[_sphere(x, y, z, 36, 18, 26, 9)] = 6  # a lesion in the right frontal white matter
    for side in (-1, 1):
        tissue[_sphere(x, y, z, side * 32, -72, -10, 12)] = 7  # eyes
    veins = (_cylinder_z(x, y, 0, 78, 4) & (z > -40)) | ((np.abs(y - 8 - 0.4 * z) < 3) & (np.abs(x) < 2) & (z > -20))
    tissue[veins & (tissue >= 3)] = 8
    return tissue


def mr_head(values: dict[int, float]) -> Field:
    """A head with sequence-specific intensities per tissue class."""
    lut = np.zeros(9)
    for k, v in values.items():
        lut[k] = v

    def field(x, y, z):
        return lut[_head_tissues(x, y, z)]

    return field


MR_T1 = Anatomy(field=mr_head({1: 820, 2: 160, 3: 520, 4: 760, 5: 130, 6: 380, 7: 300, 8: 350}), extent=(240.0, 240.0, 240.0), origin_z=-120.0)
MR_FLAIR = Anatomy(field=mr_head({1: 700, 2: 120, 3: 680, 4: 520, 5: 90, 6: 980, 7: 200, 8: 300}), extent=(240.0, 240.0, 240.0), origin_z=-120.0)
MR_DWI = Anatomy(field=mr_head({1: 280, 2: 60, 3: 420, 4: 380, 5: 260, 6: 950, 7: 200, 8: 300}), extent=(240.0, 240.0, 240.0), origin_z=-120.0)
MR_SWI = Anatomy(field=mr_head({1: 500, 2: 90, 3: 520, 4: 640, 5: 420, 6: 300, 7: 350, 8: 60}), extent=(240.0, 240.0, 240.0), origin_z=-120.0)


# ── 2-D images ───────────────────────────────────────────────────────────────────────────────


def dx_knee(rows: int, cols: int, lateral: bool, rng: np.random.Generator) -> np.ndarray:
    """A knee radiograph: femur above, tibia and fibula below, a joint space, the patella in the lateral view."""
    r, c = np.mgrid[0:rows, 0:cols].astype(np.float64)
    cx, joint = cols / 2, rows * 0.52
    img = 900.0 + 700.0 * np.exp(-(((c - cx) / (cols * 0.35)) ** 2))  # soft tissue thicker at the centre
    femur = (np.abs(c - cx) < cols * 0.11 + 0.06 * cols * np.clip((joint - r) / rows, 0, 1)) & (r < joint - rows * 0.02)
    tibia = (np.abs(c - cx + cols * 0.01) < cols * 0.10 + 0.05 * cols * np.clip((r - joint) / rows, 0, 1)) & (r > joint + rows * 0.02)
    img[femur | tibia] = 2600.0
    cortex = ((np.abs(np.abs(c - cx) - (cols * 0.11 + 0.06 * cols * np.clip((joint - r) / rows, 0, 1))) < 4) & (r < joint - rows * 0.02)) | (
        (np.abs(np.abs(c - cx + cols * 0.01) - (cols * 0.10 + 0.05 * cols * np.clip((r - joint) / rows, 0, 1))) < 4) & (r > joint + rows * 0.02)
    )
    img[cortex] = 3300.0
    if lateral:
        patella = (((c - (cx - cols * 0.19)) / (cols * 0.05)) ** 2 + ((r - (joint - rows * 0.08)) / (rows * 0.07)) ** 2) <= 1
        img[patella] = 2900.0
    else:
        fibula = (np.abs(c - (cx + cols * 0.17)) < cols * 0.03) & (r > joint + rows * 0.06)
        img[fibula] = 2500.0
    img += rng.normal(0, 35, img.shape)
    return np.clip(img, 0, 4095).astype(np.uint16)


def us_kidney(rows: int, cols: int, index: int, count: int, rng: np.random.Generator) -> np.ndarray:
    """A sector image with a kidney: hypoechoic cortex around a bright central sinus, speckle everywhere."""
    r, c = np.mgrid[0:rows, 0:cols].astype(np.float64)
    cx = cols / 2
    img = np.full((rows, cols), 15.0)
    sector = (np.abs(c - cx) <= (r * 0.72 + 3)) & (r < rows - 6)
    depth_gain = 1.0 - 0.35 * r / rows
    speckle = rng.gamma(2.0, 110.0, img.shape) * depth_gain
    img = np.where(sector, speckle, img)
    sweep = (index + 0.5) / max(count, 1) - 0.5  # the probe rocks through the organ
    kidney = (((c - cx - 12 * sweep * cols / 128) / (cols * 0.22)) ** 2 + ((r - rows * 0.6) / (rows * 0.15)) ** 2) <= 1
    sinus = (((c - cx - 12 * sweep * cols / 128) / (cols * 0.10)) ** 2 + ((r - rows * 0.6) / (rows * 0.06)) ** 2) <= 1
    img[sector & kidney] = rng.gamma(2.0, 60.0, img.shape)[sector & kidney]
    img[sector & sinus] = rng.gamma(3.0, 200.0, img.shape)[sector & sinus]
    return np.clip(img, 0, 4095).astype(np.uint16)
