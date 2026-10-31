"""
The generated DICOM studies agree with the FHIR bundle on every identifier a PACS query will be asked about,
carry the synthetic patient's MRN as PatientID, and are byte-for-byte reproducible.
"""

import hashlib
import json
from pathlib import Path

import pydicom
import pytest

from seeding import dicom_seed as ds


@pytest.fixture(scope="module")
def bundle():
    with open(ds.DEFAULT_BUNDLE, encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture(scope="module")
def generated(bundle, tmp_path_factory):
    out = tmp_path_factory.mktemp("dicom")
    return out, ds.generate(bundle, out)


def test_the_plan_is_the_bundle(bundle):
    studies = ds.studies_from_bundle(bundle)
    fhir = {e["resource"]["id"]: e["resource"] for e in bundle["entry"] if e["resource"]["resourceType"] == "ImagingStudy"}
    assert [s.fhir_id for s in studies] == list(fhir)
    for s in studies:
        declared = fhir[s.fhir_id]
        assert s.uid == declared["identifier"][0]["value"].removeprefix("urn:oid:")
        assert len(s.series) == declared["numberOfSeries"] and s.instances == declared["numberOfInstances"]
        assert [x.uid for x in s.series] == [x["uid"] for x in declared["series"]]
        assert s.started.utcoffset() is not None
    assert ds.expected_studies(bundle)["KMS-0048213"] == ["1.2.276.0.7230010.3.1.2.8323329.1001", "1.2.276.0.7230010.3.1.2.8323329.1002"]


def test_every_declared_instance_is_written_with_the_record_identity(bundle, generated):
    out, files = generated
    studies = ds.studies_from_bundle(bundle)
    assert len(files) == sum(s.instances for s in studies) == 1005
    manifest = json.loads((out / "MANIFEST.json").read_text(encoding="utf-8"))
    assert [m["uid"] for m in manifest["studies"]] == [s.uid for s in studies]

    first = pydicom.dcmread(files[0])
    assert str(first.PatientID) == "KMS-0048213" and str(first.PatientName) == "Krüger^Anneliese"
    assert first.IssuerOfPatientID == ds.MRN_SYSTEM and first.PatientBirthDate == "19580314" and first.PatientSex == "F"
    assert first.StudyInstanceUID == "1.2.276.0.7230010.3.1.2.8323329.1001" and first.SeriesInstanceUID == "1.2.276.0.7230010.3.1.2.8323329.1001.1"
    assert first.SOPInstanceUID == "1.2.276.0.7230010.3.1.2.8323329.1001.1.1"
    assert first.Modality == "CT" and first.SOPClassUID == ds.SOP_CLASS["CT"] and first.file_meta.MediaStorageSOPClassUID == ds.SOP_CLASS["CT"]
    assert (first.StudyDate, first.StudyTime, first.TimezoneOffsetFromUTC) == ("20251103", "091200", "+0100"), "the record's local time and zone"
    assert first.StudyDescription == "CT Thorax mit Kontrastmittel" and first.AccessionNumber.startswith("ACC")
    assert first.pixel_array.shape == (256, 256) and first.RescaleIntercept == -1024
    assert list(first.ImageType) == ["ORIGINAL", "PRIMARY", "LOCALIZER"], "a topogram is a projection, not a slice"

    # Series geometry: the axial CT series can be scrolled, reconstructed and rendered as a volume.
    axial = sorted(p for p in files if "8323329.1001/02/" in str(p))
    assert len(axial) == 350
    slices = [pydicom.dcmread(p, stop_before_pixels=True) for p in (axial[0], axial[1], axial[-1])]
    positions = [s.ImagePositionPatient[2] for s in slices]
    assert positions[1] - positions[0] == pytest.approx(1.0) and positions[-1] > positions[0]
    assert list(slices[0].ImageOrientationPatient) == [1, 0, 0, 0, 1, 0] and slices[0].SliceThickness == 1.0
    assert slices[0].PixelSpacing[0] == pytest.approx(380 / 256, abs=1e-3), "a 380 mm field of view on 256 pixels"
    assert len({s.FrameOfReferenceUID for s in slices}) == 1
    mid = pydicom.dcmread(axial[175]).pixel_array.astype(int) - 1024
    assert (mid < -700).sum() > 2000 and (mid > 400).sum() > 100, "lungs (air) and bone in the middle of the thorax"

    coronal = pydicom.dcmread(sorted(p for p in files if "8323329.1001/03/" in str(p))[30], stop_before_pixels=True)
    assert list(coronal.ImageOrientationPatient) == [1, 0, 0, 0, 0, -1] and list(coronal.ImageType) == ["DERIVED", "SECONDARY", "MPR"]

    sagittal = pydicom.dcmread(sorted(p for p in files if "8323329.2001/01/" in str(p))[88], stop_before_pixels=True)
    assert list(sagittal.ImageOrientationPatient) == [0, 1, 0, 0, 0, -1] and sagittal.Rows == 192 and sagittal.Modality == "MR"
    flair = [pydicom.dcmread(p, stop_before_pixels=True).ImagePositionPatient[2] for p in sorted(p for p in files if "8323329.2001/02/" in str(p))]
    assert min(flair) > -80 and max(flair) < 80 and len(flair) == 30, "the 30-slice FLAIR stack is centred on the head"

    us = pydicom.dcmread(files[-1])
    assert str(us.PatientID) == "KMS-0077501" and us.Modality == "US" and us.SOPClassUID == ds.SOP_CLASS["US"] and us.TimezoneOffsetFromUTC == "+0200"
    total = sum(p.stat().st_size for p in files) / 1e6
    assert 90 < total < 130, f"about 110 MB of DICOM, got {total:.1f}"


def test_generation_is_deterministic(bundle, generated, tmp_path):
    out, files = generated
    sample = [p for p in files if p.name == "0001.dcm"][:5]
    ds.generate(bundle, tmp_path / "again")
    for p in sample:
        twin = tmp_path / "again" / p.relative_to(out)
        assert hashlib.sha256(p.read_bytes()).hexdigest() == hashlib.sha256(twin.read_bytes()).hexdigest()


def test_seed_hash_follows_imaging_and_patient_content_only(bundle):
    h = ds.seed_hash(bundle)
    unrelated = json.loads(json.dumps(bundle))
    next(e for e in unrelated["entry"] if e["resource"]["resourceType"] == "Observation")["resource"]["status"] = "amended"
    assert ds.seed_hash(unrelated) == h, "an observation is not part of the imaging seed"
    changed = json.loads(json.dumps(bundle))
    next(e for e in changed["entry"] if e["resource"]["resourceType"] == "ImagingStudy")["resource"]["description"] = "changed"
    assert ds.seed_hash(changed) != h


def test_every_instance_carries_the_seed_marker_the_verification_reads_back(bundle, generated):
    out, files = generated
    digest = ds.seed_hash(bundle)
    marker = ds.seed_marker(digest)
    assert marker == f"{ds.GENERATOR_VERSION} {digest[:12]}" and len(marker) <= 64, "SoftwareVersions is LO: 64 characters at most"
    manifest = json.loads((out / "MANIFEST.json").read_text(encoding="utf-8"))
    assert manifest["seed_hash"] == digest and manifest["marker"] == marker
    for p in (files[0], files[len(files) // 2], files[-1]):
        assert str(pydicom.dcmread(p).SoftwareVersions) == marker


def test_phantoms_are_anatomy_in_patient_coordinates():
    import numpy as np

    from seeding import phantoms

    x, y, z = np.array([12.0, 0.0, -68.0, 6.0]), np.array([88.0, -300.0, -12.0, 38.0]), np.array([175.0, 175.0, 185.0, 200.0])
    hu = phantoms.ct_thorax(x, y, z)
    assert hu[0] > 500 and hu[1] == -1024 and hu[2] < -700 and hu[3] > 250, "spine, air outside the body, lung, contrast in the aorta"
    tissue = phantoms._head_tissues(np.array([-30.0, 14.0]), np.array([8.0, 6.0]), np.array([-4.0, 6.0]))
    assert tissue[0] == 4 and tissue[1] == 5, "white matter at the centre, CSF in a ventricle"
    plan = ds.plan_for(ds.studies_from_bundle(json.load(open(ds.DEFAULT_BUNDLE, encoding="utf-8")))[0], ds.studies_from_bundle(json.load(open(ds.DEFAULT_BUNDLE, encoding="utf-8")))[0].series[1])
    assert plan.kind == "volume" and plan.orientation == "axial" and plan.thickness == 1.0 and plan.matrix == 256
    assert Path(ds.DEFAULT_BUNDLE).exists()
