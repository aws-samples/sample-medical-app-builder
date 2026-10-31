"""
The imaging half of the synthetic record: DICOM studies for the reference PACS, generated from the same bundle
the FHIR server is seeded with, so the two agree on every UID.

Every `ImagingStudy` in synthetic-musterstadt.bundle.json becomes a study with exactly the series and instance counts
it declares, its StudyInstanceUID and SeriesInstanceUIDs, its dates (with the timezone the record has), the
patient's hospital MRN as DICOM `PatientID` — the join a real PACS gives you — and the patient's name, birth
date and sex. Pixel data comes from analytic phantoms (`phantoms.py`): a trunk with lungs, heart, aorta, spine
and ribs for the CT, a head for the MR, sampled on each series' own plane — axial acquisitions, the coronal
reformat, the sagittal T1 — with the geometry a viewer needs to scroll, reconstruct (MPR) and render in 3-D.
256×256 for CT, 192×192 for MR, 16-bit MONOCHROME2. Nothing here is or resembles a real patient's image.

Generation is deterministic — the same bundle gives byte-identical files (seeded noise, no timestamps of
"now") — so the staged directory has a stable content hash and a deploy only uploads when the seed changed.
Requires pydicom and numpy (in requirements.txt: `cdk synth` stages this).
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

INFRA_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BUNDLE = INFRA_ROOT / "lambdas" / "dispatcher" / "data" / "synthetic-musterstadt.bundle.json"
BUILD = INFRA_ROOT / ".build" / "dicom-seed"

MATRIX = {"CT": 256, "MR": 192, "DX": 256, "US": 192}  # rows = columns per modality
MRN_SYSTEM = "https://klinikum-musterstadt.example/fhir/sid/mrn"
DCM = "http://dicom.nema.org/resources/ontology/DCM"

# SOP class per modality — what a real device of that kind writes.
SOP_CLASS = {
    "CT": "1.2.840.10008.5.1.4.1.1.2",
    "MR": "1.2.840.10008.5.1.4.1.1.4",
    "DX": "1.2.840.10008.5.1.4.1.1.1.1",  # Digital X-Ray Image Storage – For Presentation
    "CR": "1.2.840.10008.5.1.4.1.1.1",
    "US": "1.2.840.10008.5.1.4.1.1.6.1",
    "NM": "1.2.840.10008.5.1.4.1.1.20",
    "PT": "1.2.840.10008.5.1.4.1.1.128",
    "MG": "1.2.840.10008.5.1.4.1.1.1.2",
    "XA": "1.2.840.10008.5.1.4.1.1.12.1",
}
EXPLICIT_VR_LITTLE_ENDIAN = "1.2.840.10008.1.2.1"
IMPLEMENTATION_UID = "1.2.276.0.7230010.3.0.3.6.7"  # a made-up implementation root for the synthetic writer
BODY_PART = {"Thorax": "CHEST", "Abdomen": "ABDOMEN", "Head": "HEAD", "Knee": "KNEE", "Kidney": "KIDNEY"}


@dataclass(frozen=True)
class SeedPatient:
    fhir_id: str
    mrn: str
    family: str
    given: str
    birth_date: str  # YYYY-MM-DD
    sex: str  # M | F | O

    @property
    def dicom_name(self) -> str:
        return f"{self.family}^{self.given}"


@dataclass(frozen=True)
class SeedSeries:
    uid: str
    number: int
    modality: str
    description: str
    instances: int
    body_part: str | None


@dataclass(frozen=True)
class SeedStudy:
    fhir_id: str
    uid: str
    patient: SeedPatient
    modality: str
    description: str
    started: datetime  # timezone-aware
    referrer: str | None
    series: tuple[SeedSeries, ...]

    @property
    def accession_number(self) -> str:
        return "ACC" + re.sub(r"\D", "", self.fhir_id)[-8:].rjust(8, "0")

    @property
    def instances(self) -> int:
        return sum(s.instances for s in self.series)


def _patients(bundle: dict[str, Any]) -> dict[str, SeedPatient]:
    out: dict[str, SeedPatient] = {}
    for entry in bundle.get("entry", []):
        r = entry.get("resource") or {}
        if r.get("resourceType") != "Patient":
            continue
        idents = r.get("identifier") or []
        mrn = next((i.get("value") for i in idents if i.get("system") == MRN_SYSTEM), None) or next((i.get("value") for i in idents if i.get("value")), r["id"])
        name = (r.get("name") or [{}])[0]
        sex = {"male": "M", "female": "F"}.get(str(r.get("gender") or ""), "O")
        out[r["id"]] = SeedPatient(fhir_id=r["id"], mrn=str(mrn), family=str(name.get("family") or ""), given=" ".join(name.get("given") or []), birth_date=str(r.get("birthDate") or ""), sex=sex)
    return out


def _uid_of(study: dict[str, Any]) -> str:
    for ident in study.get("identifier") or []:
        if ident.get("system") == "urn:dicom:uid" and str(ident.get("value", "")).startswith("urn:oid:"):
            return str(ident["value"])[len("urn:oid:") :]
    raise ValueError(f"ImagingStudy {study.get('id')} has no urn:dicom:uid identifier")


def studies_from_bundle(bundle: dict[str, Any]) -> list[SeedStudy]:
    """Every ImagingStudy of the bundle as a generation plan, in bundle order."""
    patients = _patients(bundle)
    studies: list[SeedStudy] = []
    for entry in bundle.get("entry", []):
        r = entry.get("resource") or {}
        if r.get("resourceType") != "ImagingStudy":
            continue
        patient_id = str((r.get("subject") or {}).get("reference", "")).removeprefix("Patient/")
        if patient_id not in patients:
            raise ValueError(f"ImagingStudy {r.get('id')} refers to unknown {patient_id}")
        modality = ((r.get("modality") or [{}])[0]).get("code") or "OT"
        series = tuple(
            SeedSeries(
                uid=str(s["uid"]),
                number=int(s.get("number") or i + 1),
                modality=((s.get("modality") or {}).get("code")) or modality,
                description=str(s.get("description") or ""),
                instances=max(1, int(s.get("numberOfInstances") or 1)),
                body_part=BODY_PART.get(str((s.get("bodySite") or {}).get("display") or "")),
            )
            for i, s in enumerate(r.get("series") or [])
        )
        if not series:
            raise ValueError(f"ImagingStudy {r.get('id')} declares no series")
        started = datetime.fromisoformat(str(r["started"]))
        if started.tzinfo is None:
            raise ValueError(f"ImagingStudy {r.get('id')}: started must carry a timezone")
        studies.append(SeedStudy(fhir_id=r["id"], uid=_uid_of(r), patient=patients[patient_id], modality=modality, description=str(r.get("description") or ""), started=started, referrer=(r.get("referrer") or {}).get("display"), series=series))
    return studies


# ── what each series is made of ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SeriesPlan:
    """How a series samples its anatomy: which phantom, which plane, how fine, how thick."""

    kind: str  # volume | localizer | dx | us
    matrix: int
    orientation: str = "axial"  # axial | coronal | sagittal
    thickness: float = 1.0  # slice thickness and spacing between slices (mm)
    anatomy: Any = None  # phantoms.Anatomy for volumes and localizers
    derived: bool = False  # an MPR reformat rather than an acquisition
    lateral: bool = False  # radiographs: the second projection


def plan_for(study: SeedStudy, series: SeedSeries) -> SeriesPlan:
    """The generation plan of a series, from the record's descriptions — the same words the clinician sees."""
    from . import phantoms

    text = f"{study.description} {series.description}".lower()
    if series.modality == "CT":
        anatomy = phantoms.CT_ABDOMEN if "abdomen" in text else phantoms.CT_THORAX
        if "topogram" in text or "localizer" in text:
            return SeriesPlan("localizer", 256, anatomy=anatomy)
        if "coronal" in text:
            return SeriesPlan("volume", 256, "coronal", anatomy.extent[1] / series.instances, anatomy, derived=True)
        if "sagittal" in text:
            return SeriesPlan("volume", 256, "sagittal", anatomy.extent[0] / series.instances, anatomy, derived=True)
        return SeriesPlan("volume", 256, "axial", 3.0 if "3 mm" in text else 1.0, anatomy)
    if series.modality == "MR":
        anatomy = phantoms.MR_T1
        if "flair" in text or "t2" in text:
            anatomy = phantoms.MR_FLAIR
        elif "dwi" in text:
            anatomy = phantoms.MR_DWI
        elif "swi" in text:
            anatomy = phantoms.MR_SWI
        if "sagittal" in text:
            return SeriesPlan("volume", 192, "sagittal", anatomy.extent[0] * 0.75 / series.instances, anatomy)
        if "coronal" in text:
            return SeriesPlan("volume", 192, "coronal", anatomy.extent[1] * 0.75 / series.instances, anatomy)
        return SeriesPlan("volume", 192, "axial", min(5.0, anatomy.extent[2] * 0.7 / series.instances), anatomy)
    if series.modality in ("DX", "CR"):
        return SeriesPlan("dx", 256, lateral=("seitlich" in text or "lateral" in text))
    if series.modality == "US":
        return SeriesPlan("us", 192)
    return SeriesPlan("volume", 128, "axial", 2.0, phantoms.CT_THORAX)


ORIENTATIONS = {
    # row direction, column direction (DICOM ImageOrientationPatient), and the axis the slices step along
    "axial": ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), 2),
    "coronal": ((1.0, 0.0, 0.0), (0.0, 0.0, -1.0), 1),
    "sagittal": ((0.0, 1.0, 0.0), (0.0, 0.0, -1.0), 0),
}


@dataclass(frozen=True)
class SliceGeometry:
    rows: int
    columns: int
    pixel_spacing: float
    orientation: tuple[float, ...]  # 6 values
    position: tuple[float, float, float]
    thickness: float
    location: float


def slice_geometry(plan: SeriesPlan, index: int, count: int) -> SliceGeometry:
    """Where slice `index` of a volume series lies: a square field of view covering the anatomy on that plane."""
    extent, origin_z = plan.anatomy.extent, plan.anatomy.origin_z
    row_dir, col_dir, step_axis = ORIENTATIONS[plan.orientation]
    n = plan.matrix
    if plan.orientation == "axial":
        fov = max(extent[0], extent[1])
        ps = fov / n
        # The stack is centred on the anatomy's length: a 30-slice FLAIR sits in the middle of the head, not below it.
        z = origin_z + extent[2] / 2 - (count - 1) * plan.thickness / 2 + index * plan.thickness
        position = (-fov / 2 + ps / 2, -fov / 2 + ps / 2, round(z, 3))
        location = z
    elif plan.orientation == "coronal":
        fov = max(extent[0], extent[2])
        ps = fov / n
        y = -extent[1] / 2 + plan.thickness / 2 + index * plan.thickness
        top = origin_z + extent[2] / 2 + fov / 2 - ps / 2
        position = (-fov / 2 + ps / 2, y, top)
        location = y
    else:  # sagittal
        fov = max(extent[1], extent[2])
        ps = fov / n
        x = -extent[0] / 2 + plan.thickness / 2 + index * plan.thickness
        top = origin_z + extent[2] / 2 + fov / 2 - ps / 2
        position = (x, -fov / 2 + ps / 2, top)
        location = x
    del step_axis
    return SliceGeometry(n, n, ps, (*row_dir, *col_dir), position, plan.thickness, location)


def sample_plane(plan: SeriesPlan, geometry: SliceGeometry, seed: int, modality: str):
    """Evaluate the anatomy on the slice's pixel grid and add the modality's noise; stored values as uint16."""
    import numpy as np

    n = geometry.rows
    i, j = np.mgrid[0:n, 0:n].astype(np.float64)  # i = row (down the image), j = column (across)
    r, c = geometry.orientation[:3], geometry.orientation[3:]
    p, ps = geometry.position, geometry.pixel_spacing
    x = p[0] + j * ps * r[0] + i * ps * c[0]
    y = p[1] + j * ps * r[1] + i * ps * c[1]
    z = p[2] + j * ps * r[2] + i * ps * c[2]
    values = plan.anatomy.field(x, y, z).astype(np.float64)
    rng = np.random.default_rng(seed)
    if modality == "CT":
        values = values + 1024.0 + rng.normal(0, 14, values.shape)  # HU → stored (RescaleIntercept −1024)
    else:
        values = values + rng.normal(0, 22, values.shape)
    return np.clip(values, 0, 4095).astype(np.uint16)


def localizer_image(plan: SeriesPlan, lateral: bool, seed: int):
    """A CT topogram: the volume projected through, front-to-back or side-to-side, on a 256×256 grid."""
    import numpy as np

    extent, origin_z = plan.anatomy.extent, plan.anatomy.origin_z
    n = plan.matrix
    fov = max(extent[0], extent[1], extent[2])
    ps = fov / n
    i, j = np.mgrid[0:n, 0:n].astype(np.float64)
    z = origin_z + extent[2] / 2 + fov / 2 - ps / 2 - i * ps  # rows: head at the top
    across = -fov / 2 + ps / 2 + j * ps
    steps = np.linspace(-fov / 2, fov / 2, 48)
    acc = np.zeros((n, n))
    for s in steps:
        if lateral:
            hu = plan.anatomy.field(np.full_like(z, s), across, z)  # project along x; columns run along y
        else:
            hu = plan.anatomy.field(across, np.full_like(z, s), z)  # project along y; columns run along x
        acc += np.clip(hu, -1000, 3000) + 1000.0  # attenuation-like: air contributes nothing
    values = 4095.0 * (1.0 - np.exp(-acc / (len(steps) * 1800.0)))
    values += np.random.default_rng(seed).normal(0, 20, values.shape)
    return np.clip(values, 0, 4095).astype(np.uint16), ps, fov


# ── DICOM ────────────────────────────────────────────────────────────────────────────────


def _dicom_date(dt: datetime) -> str:
    return dt.strftime("%Y%m%d")


def _dicom_time(dt: datetime) -> str:
    return dt.strftime("%H%M%S")


def _dicom_offset(dt: datetime) -> str:
    offset = dt.utcoffset()
    minutes = int(offset.total_seconds() // 60) if offset is not None else 0
    sign = "+" if minutes >= 0 else "-"
    minutes = abs(minutes)
    return f"{sign}{minutes // 60:02d}{minutes % 60:02d}"


def instance_dataset(study: SeedStudy, series: SeedSeries, index: int, plan: SeriesPlan | None = None, marker: str | None = None):
    """
    One SOP instance (index is 0-based within the series) as a pydicom FileDataset, deterministic. `marker` is the
    seed's generation marker (`seed_marker()`), stored in SoftwareVersions so a running PACS can be asked which
    seed it serves.
    """
    import numpy as np
    from pydicom.dataset import FileDataset, FileMetaDataset

    plan = plan or plan_for(study, series)
    sop_class = SOP_CLASS.get(series.modality, "1.2.840.10008.5.1.4.1.1.7")  # Secondary Capture for anything else
    sop_uid = f"{series.uid}.{index + 1}"
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = sop_class
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = EXPLICIT_VR_LITTLE_ENDIAN
    meta.ImplementationClassUID = IMPLEMENTATION_UID
    meta.ImplementationVersionName = "MEDAPP_SYNTH_1"

    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SpecificCharacterSet = "ISO_IR 192"
    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = sop_uid
    if plan.kind == "localizer":
        ds.ImageType = ["ORIGINAL", "PRIMARY", "LOCALIZER"]
    elif plan.kind == "volume":
        ds.ImageType = ["DERIVED", "SECONDARY", "MPR"] if plan.derived else ["ORIGINAL", "PRIMARY", plan.orientation.upper()]
    else:
        ds.ImageType = ["ORIGINAL", "PRIMARY"]
    ds.Modality = series.modality
    ds.Manufacturer = "MedApp synthetic"
    ds.ManufacturerModelName = f"phantom-{plan.matrix}"
    ds.SoftwareVersions = marker or GENERATOR_VERSION
    ds.InstitutionName = "Klinikum Musterstadt (synthetic record)"
    ds.StationName = "SYNTH01"

    ds.PatientName = study.patient.dicom_name
    ds.PatientID = study.patient.mrn
    ds.IssuerOfPatientID = MRN_SYSTEM
    ds.PatientBirthDate = study.patient.birth_date.replace("-", "")
    ds.PatientSex = study.patient.sex

    ds.StudyInstanceUID = study.uid
    ds.StudyDate = _dicom_date(study.started)
    ds.StudyTime = _dicom_time(study.started)
    ds.TimezoneOffsetFromUTC = _dicom_offset(study.started)
    ds.StudyDescription = study.description
    ds.StudyID = study.fhir_id
    ds.AccessionNumber = study.accession_number
    ds.ReferringPhysicianName = (study.referrer or "").replace(" ", "^", 1) if study.referrer else ""

    ds.SeriesInstanceUID = series.uid
    ds.SeriesNumber = series.number
    ds.SeriesDescription = series.description
    ds.SeriesDate, ds.SeriesTime = ds.StudyDate, ds.StudyTime
    if series.body_part:
        ds.BodyPartExamined = series.body_part
    ds.InstanceNumber = index + 1
    ds.ContentDate, ds.ContentTime = ds.StudyDate, ds.StudyTime
    ds.FrameOfReferenceUID = f"{study.uid}.9"
    ds.PositionReferenceIndicator = ""

    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows, ds.Columns = plan.matrix, plan.matrix
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 12, 11
    ds.PixelRepresentation = 0
    seed = _seed(sop_uid)
    if plan.kind == "volume":
        geometry = slice_geometry(plan, index, series.instances)
        pixels = sample_plane(plan, geometry, seed, series.modality)
        ds.SliceThickness = round(geometry.thickness, 3)
        ds.SpacingBetweenSlices = round(geometry.thickness, 3)
        ds.PixelSpacing = [round(geometry.pixel_spacing, 4), round(geometry.pixel_spacing, 4)]
        ds.ImageOrientationPatient = [float(v) for v in geometry.orientation]
        ds.ImagePositionPatient = [round(float(v), 3) for v in geometry.position]
        ds.SliceLocation = round(geometry.location, 3)
    elif plan.kind == "localizer":
        pixels, ps, fov = localizer_image(plan, lateral=(index % 2 == 1), seed=seed)
        ds.SliceThickness = 1.0
        ds.PixelSpacing = [round(ps, 4), round(ps, 4)]
        ds.ImageOrientationPatient = [0.0, 1.0, 0.0, 0.0, 0.0, -1.0] if index % 2 == 1 else [1.0, 0.0, 0.0, 0.0, 0.0, -1.0]
        top = plan.anatomy.origin_z + plan.anatomy.extent[2] / 2 + fov / 2 - ps / 2
        ds.ImagePositionPatient = [-fov / 2 + ps / 2, -fov / 2 + ps / 2, round(top, 3)]
    elif plan.kind == "dx":
        pixels = phantoms_module().dx_knee(plan.matrix, plan.matrix, plan.lateral, np.random.default_rng(seed))
    else:
        pixels = phantoms_module().us_kidney(plan.matrix, plan.matrix, index, series.instances, np.random.default_rng(seed))
    ds.PixelData = pixels.tobytes()

    if series.modality == "CT":
        ds.RescaleIntercept, ds.RescaleSlope = -1024, 1
        ds.RescaleType = "HU"
        ds.WindowCenter, ds.WindowWidth = 40, 400
        ds.KVP = 120
    elif series.modality == "MR":
        ds.WindowCenter, ds.WindowWidth = 500, 1000
        ds.MagneticFieldStrength = 1.5
        ds.ScanningSequence, ds.SequenceVariant, ds.ScanOptions = "SE", "NONE", ""
        ds.MRAcquisitionType = "3D" if plan.thickness <= 1.5 else "2D"
        ds.EchoTime, ds.RepetitionTime = 12, 500
    elif series.modality == "US":
        ds.WindowCenter, ds.WindowWidth = 400, 800
    else:
        ds.WindowCenter, ds.WindowWidth = 1800, 3000
        ds.PixelSpacing = [0.7, 0.7]
        ds.ImagerPixelSpacing = [0.7, 0.7]
        ds.PresentationIntentType = "FOR PRESENTATION"
        if study.description and "rechts" in study.description.lower():
            ds.Laterality = "R"
        elif study.description and "links" in study.description.lower():
            ds.Laterality = "L"
    return ds


def _seed(text: str) -> int:
    return int(hashlib.sha256(text.encode()).hexdigest()[:8], 16)


def phantoms_module():
    from . import phantoms

    return phantoms


def write_study(study: SeedStudy, out_dir: Path, marker: str | None = None) -> list[Path]:
    """`<out_dir>/<study uid>/<series number>/<instance>.dcm` for every declared instance."""
    written: list[Path] = []
    for series in study.series:
        folder = out_dir / study.uid / f"{series.number:02d}"
        folder.mkdir(parents=True, exist_ok=True)
        plan = plan_for(study, series)
        for index in range(series.instances):
            ds = instance_dataset(study, series, index, plan, marker)
            path = folder / f"{index + 1:04d}.dcm"
            ds.save_as(path, enforce_file_format=True)
            written.append(path)
    return written


def generate(bundle: dict[str, Any], out_dir: Path) -> list[Path]:
    """All studies of the bundle into out_dir (emptied first); returns the files written."""
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    digest = seed_hash(bundle)
    marker = seed_marker(digest)
    files: list[Path] = []
    for study in studies_from_bundle(bundle):
        files.extend(write_study(study, out_dir, marker))
    manifest = {
        "seed_hash": digest,
        "marker": marker,
        "studies": [{"fhir_id": s.fhir_id, "uid": s.uid, "patient_id": s.patient.mrn, "series": len(s.series), "instances": s.instances} for s in studies_from_bundle(bundle)],
    }
    (out_dir / "MANIFEST.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    return files


def seed_marker(digest: str) -> str:
    """
    What every instance says in SoftwareVersions: the generator version and the first twelve hex digits of the
    seed hash. The seed verification reads it back from the running PACS — a task still serving an older seed
    (the init container copies the seed only at start) is a finding, not a silent mismatch between what was
    deployed and what the viewer shows.
    """
    return f"{GENERATOR_VERSION} {digest[:12]}"


def seed_hash(bundle: dict[str, Any]) -> str:
    """
    What the generated set depends on: the imaging and patient parts of the bundle, this generator's version, and
    the source of the generator and its phantoms — so editing a phantom regenerates the seed without anyone
    remembering to bump the version (the asset hash, and with it the deploy, follows).
    """
    relevant = [e["resource"] for e in bundle.get("entry", []) if (e.get("resource") or {}).get("resourceType") in ("ImagingStudy", "Patient")]
    sources = "".join((Path(__file__).parent / name).read_text(encoding="utf-8") for name in ("dicom_seed.py", "phantoms.py"))
    return hashlib.sha256((GENERATOR_VERSION + sources + json.dumps(relevant, sort_keys=True, separators=(",", ":"), ensure_ascii=False)).encode("utf-8")).hexdigest()


GENERATOR_VERSION = "dicom-seed-2"


def stage_dicom_seed(bundle_path: Path | None = None) -> str:
    """Generate into .build/dicom-seed (cached by seed hash); returns the directory for a CDK asset."""
    with open(bundle_path or DEFAULT_BUNDLE, encoding="utf-8") as f:
        bundle = json.load(f)
    digest = seed_hash(bundle)
    stamp = BUILD.parent / "dicom-seed.stamp"
    if stamp.exists() and stamp.read_text(encoding="utf-8") == digest and (BUILD / "MANIFEST.json").exists():
        return str(BUILD)
    generate(bundle, BUILD)
    stamp.write_text(digest, encoding="utf-8")
    return str(BUILD)


def expected_studies(bundle: dict[str, Any]) -> dict[str, list[str]]:
    """MRN → the StudyInstanceUIDs the PACS must return for that patient — what the seed verification checks."""
    out: dict[str, list[str]] = {}
    for study in studies_from_bundle(bundle):
        out.setdefault(study.patient.mrn, []).append(study.uid)
    return out


def iter_files(root: Path) -> Iterable[Path]:
    yield from sorted(p for p in root.rglob("*.dcm"))
