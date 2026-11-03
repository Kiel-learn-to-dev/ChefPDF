"""T8.05: the verified DocAligner artifact runs locally, with confidence-based fallback."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from conftest import Harness
from pageimg_support import page_image_pdf_bytes, photo_scene, quad_error
from PIL import Image

from chef_core.imaging import docaligner
from chef_core.imaging.pageimg import PageQuad

MODEL_DIR = Path(__file__).parents[1] / "chef_core" / "resources" / "models" / "docaligner-1.1.1"
PHOTO_DIR = Path(__file__).parent / "fixtures"


def test_official_model_hash_license_and_real_cpu_inference() -> None:
    manifest = json.loads((MODEL_DIR / "manifest.json").read_text(encoding="utf-8-sig"))
    model_path = MODEL_DIR / manifest["file"]
    model_hash = hashlib.sha256(model_path.read_bytes()).hexdigest()
    assert model_hash == manifest["sha256"] == docaligner.MODEL_SHA256
    assert model_path.stat().st_size == manifest["bytes"]
    assert "Apache License" in (MODEL_DIR / "LICENSE").read_text(encoding="utf-8")
    runtime_license = MODEL_DIR / manifest["runtime"]["licenseFile"]
    runtime_notices = MODEL_DIR / manifest["runtime"]["thirdPartyNoticesFile"]
    assert "MIT License" in runtime_license.read_text(encoding="utf-8")
    assert runtime_notices.is_file() and runtime_notices.stat().st_size > 100_000

    scene = photo_scene(size=(1200, 900), noise=20, skin_blob=True)
    result = docaligner.detect_page_quad(scene.rgb)
    assert result is not None
    assert result.method == "docaligner-lcnet100"
    assert result.confidence > 0.6
    assert quad_error(result.corners, scene.quad, (1200, 900)) < 0.025


def test_better_confidence_wins_and_missing_model_falls_back() -> None:
    classical = PageQuad(np.zeros((4, 2)), 0.4, "photo-lines", 0.6)
    learned = PageQuad(np.ones((4, 2)), 0.7, "docaligner-lcnet100", 0.8)
    assert docaligner.prefer_confident_quad(classical, learned) is learned
    assert docaligner.prefer_confident_quad(classical, None) is classical
    assert docaligner.prefer_confident_quad(learned, classical) is learned


def test_unavailable_local_model_falls_back_without_downloading(monkeypatch) -> None:
    from chef_core.ops import pageimg as pageimg_ops

    classical = PageQuad(np.zeros((4, 2)), 0.4, "photo-lines", 0.6)
    monkeypatch.setattr(pageimg_ops.pi, "detect_page_quad", lambda _img: classical)
    monkeypatch.setattr(
        pageimg_ops.da,
        "detect_page_quad",
        lambda _img: (_ for _ in ()).throw(FileNotFoundError("missing bundled model")),
    )
    assert pageimg_ops._best_quad(np.zeros((32, 32, 3), dtype=np.uint8)) is classical


def test_detect_quad_operation_uses_verified_model_when_more_confident(
    harness: Harness, tmp_path: Path, monkeypatch
) -> None:
    scene = photo_scene(size=(1200, 900), noise=20, skin_blob=True)
    source = tmp_path / "photo.pdf"
    source.write_bytes(page_image_pdf_bytes(scene.rgb)[0])
    sid = str(harness.open(source)["state"]["sessionId"])
    classical = PageQuad(np.zeros((4, 2)), 0.2, "photo-lines", 0.55)
    learned = PageQuad(scene.quad.copy(), 0.9, "docaligner-lcnet100", 0.9)
    from chef_core.ops import pageimg as pageimg_ops

    monkeypatch.setattr(pageimg_ops.pi, "detect_page_quad", lambda _img: classical)
    monkeypatch.setattr(pageimg_ops.da, "detect_page_quad", lambda _img: learned)
    rows = harness.op("pageimg.detectQuad", {}, sid)["data"]["pages"]
    assert rows[0]["method"] == "docaligner-lcnet100"
    assert quad_error(np.asarray(rows[0]["corners"]), scene.quad, (1200, 900)) < 0.025


def test_official_real_photo_fixture_selects_model_through_detect_quad(
    harness: Harness, tmp_path: Path
) -> None:
    fixture = PHOTO_DIR / "docaligner-run-test-card.jpg"
    provenance_path = PHOTO_DIR / "docaligner-run-test-card.json"
    provenance = json.loads(provenance_path.read_text(encoding="utf-8-sig"))
    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == provenance["sha256"]
    assert provenance["license"] == "Apache-2.0"
    assert "Apache License" in (PHOTO_DIR / provenance["licenseFile"]).read_text(encoding="utf-8")
    rgb = np.asarray(Image.open(fixture).convert("RGB"))
    source = tmp_path / "real-photo.pdf"
    source.write_bytes(page_image_pdf_bytes(rgb)[0])
    sid = str(harness.open(source)["state"]["sessionId"])
    row = harness.op("pageimg.detectQuad", {}, sid)["data"]["pages"][0]
    assert row["method"] == "docaligner-lcnet100"
    assert row["confidence"] > 0.5
    # Points published with this official example in the upstream README.
    expected = np.array([[48.15, 223.47], [387.13, 198.09], [423.03, 345.51], [40.14, 361.38]])
    assert np.max(np.linalg.norm(np.asarray(row["corners"]) - expected, axis=1)) < 20


def test_low_confidence_photo_is_left_unchanged_by_auto_crop(
    harness: Harness, tmp_path: Path
) -> None:
    weak = photo_scene(
        size=(1240, 1754),
        seed=81,
        background="plain",
        bg_colour=(192, 190, 182),
        paper_colour=(199, 197, 189),
        noise=1.0,
    )
    source = tmp_path / "weak-photo.pdf"
    source.write_bytes(page_image_pdf_bytes(weak.rgb)[0])
    sid = str(harness.open(source)["state"]["sessionId"])
    before = Path(harness.call("session.state", {"sessionId": sid})["revisionPath"]).read_bytes()
    result = harness.op("pageimg.autoCrop", {"minConfidence": 0.6}, sid)
    row = result["data"]["pages"][0]
    assert row["status"] == "review"
    assert row["confidence"] < 0.6
    assert result["changedPages"] == []
    after = Path(harness.call("session.state", {"sessionId": sid})["revisionPath"]).read_bytes()
    assert after == before
