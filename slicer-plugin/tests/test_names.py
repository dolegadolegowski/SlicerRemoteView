"""SLC-23: display-name sanitising and anonymised substitutes (docs/protocol.md §7.3, FR-15, T7)."""

from __future__ import annotations

import random
import subprocess
import sys
import unicodedata
from pathlib import Path

import numpy as np
import pytest
from pygltflib import GLTF2

from remoteview_core import names
from remoteview_core.glb_writer import (
    FORBIDDEN_NAME_CATEGORIES,
    Entity,
    RootExtras,
    is_valid_name,
    write_glb,
)
from remoteview_core.names import NameAssigner, anonymous_name, sanitize_name


def _utf16_units(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


# --------------------------------------------------------------------------- sanitising (criterion 1)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Patient\u0007 Name  ", "Patient Name"),  # the plan's example
        ("Liver", "Liver"),
        ("Wątroba – lewy płat", "Wątroba – lewy płat"),  # diacritics and en dash survive
        (
            "  Left\tlung\r\nupper lobe ",
            "Left lung upper lobe",
        ),  # separators keep the word boundary
        ("Line\u2028break\u2029here", "Line break here"),  # Zl, Zp
        ("Liver\u202egnp.exe", "Livergnp.exe"),  # bidi override (Cf) removed
        ("Li\u200bver\ufeff", "Liver"),  # zero-width space, BOM (Cf)
        ("Tumor\ud800", "Tumor"),  # lone surrogate (Cs)
        ("Private\ue000use", "Privateuse"),  # private use (Co)
        ("Un\u0378assigned", "Unassigned"),  # unassigned (Cn)
        ("a\u00a0\u00a0b\u3000c", "a b c"),  # no-break and ideographic spaces collapse
        ("\x1f\x85x\x0b", "x"),  # C0/C1 controls that Python counts as whitespace
        ("", ""),
        ("   ", ""),
        (None, ""),
    ],
)
def test_names_sanitize_examples(raw, expected):
    assert sanitize_name(raw) == expected


def test_names_every_forbidden_category_is_removed():
    by_category = {
        "Cc": "\x07",
        "Cf": "\u202e",
        "Cs": "\udfff",
        "Co": "\U000f0000",
        "Cn": "\U0010fffe",
        "Zl": "\u2028",
        "Zp": "\u2029",
    }
    assert set(by_category) == FORBIDDEN_NAME_CATEGORIES
    for category, ch in by_category.items():
        assert unicodedata.category(ch) == category
        assert ch not in sanitize_name(f"A{ch}B"), category


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("x" * 100, "x" * 64),
        ("x" * 63 + " yz", "x" * 63),  # cut at a space: trailing space trimmed
        ("\U0001f600" * 40, "\U0001f600" * 32),  # astral characters count twice
        (
            "x" * 63 + "\U0001f600",
            "x" * 63,
        ),  # an astral character that does not fit is dropped whole
        ("é" * 64, "é" * 64),
        (
            "x" * 62 + "\u0301\u0301\u0301",
            "x" * 62,
        ),  # cut inside a combining sequence: its marks go
        (
            "x" * 59 + "cafe\u0301 ward",
            "x" * 59 + "cafe\u0301",
        ),  # cut after a complete sequence: kept
        ("x" * 62 + " \u0301y", "x" * 62 + " \u0301"),  # the mark was the input's own (on a space)
        ("x" * 62 + "\U0001f1f5\U0001f1f1", "x" * 62),  # nor half of a flag
        ("x" * 60 + "\U0001f1f5\U0001f1f1" * 2, "x" * 60 + "\U0001f1f5\U0001f1f1"),
        (
            "x" * 61 + "\U0001f1e7 \U0001f1ea",
            "x" * 61 + "\U0001f1e7",
        ),  # a lone indicator stays whole
        ("x" * 63 + "\u0301", "x" * 63 + "\u0301"),  # not cut: the mark stays on its base
    ],
)
def test_names_are_cut_to_64_utf16_units(raw, expected):
    assert sanitize_name(raw) == expected
    assert _utf16_units(sanitize_name(raw)) <= 64


def test_names_random_inputs_always_satisfy_the_writer():
    """10,000 random names mixing every category: the result passes the writer's check, fits 64 UTF-16 units and
    sanitising is idempotent (seeded, so the run is reproducible)."""
    rng = random.Random(20261019)  # noqa: S311 — reproducible test data, not a secret
    pools = [
        "abcXYZ019 -_.()",
        "ąęłńóśźżĄĘŁŃÓŚŹŻé",
        "\t\n\r\x0b\x0c\x1c\x1f\x85\x00\x07\x7f\x9f",
        "\u200b\u200c\u200d\u202a\u202e\u2066\u2069\ufeff\u00ad",
        "\u00a0\u2000\u2007\u202f\u205f\u3000",
        "\u2028\u2029",
        "\ud800\udbff\udc00\udfff",  # lone surrogates (never combined in a Python str)
        "\ue000\uf8ff\U000f0000",
        "\u0378\u0379\U0010fffe",
        "\u0301\u20dd\ufe0f",
        "\U0001f600\U0001f9e0\U00010348",
        "<>&\"'/\\",
    ]
    for _ in range(10_000):
        raw = "".join(rng.choice(rng.choice(pools)) for _ in range(rng.randrange(0, 150)))
        name = sanitize_name(raw)
        assert is_valid_name(name), repr(raw)
        assert _utf16_units(name) <= 64
        assert sanitize_name(name) == name, repr(raw)
        assert not any(unicodedata.category(ch) in FORBIDDEN_NAME_CATEGORIES for ch in name)
        name.encode("utf-8")  # no lone surrogate survives (it would fail to encode)


def test_names_bytes_from_vtk_are_decoded():
    """VTK's Python wrapping returns bytes for a name that is not valid UTF-8 (e.g. a legacy cp1250 file)."""
    assert sanitize_name(b"Liver") == "Liver"
    assert sanitize_name(b"Kowalski \xb3\xf3d\xbc") == "Kowalski \ufffd\ufffdd\ufffd"
    assert NameAssigner().assign("segment", b"P\xb3uco") == "P\ufffduco"
    for bad in (42, ["Liver"], bytearray(b"Liver")):
        with pytest.raises(TypeError):
            sanitize_name(bad)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- substitutes (criterion 2)


def test_names_anonymous_substitutes():
    assert anonymous_name("model", 1) == "Model 1"
    assert anonymous_name("segment", 12) == "Segment 12"
    for kind, number in (("volume", 1), ("model", 0), ("model", True), ("model", 1.0)):
        with pytest.raises(ValueError):
            anonymous_name(kind, number)  # type: ignore[arg-type]


def test_names_assigner_numbers_per_kind_in_export_order():
    hidden = NameAssigner(anonymize=True)
    assert [
        hidden.assign("model", "Jan Kowalski skull"),
        hidden.assign("segment", "Liver"),
        hidden.assign("model", None),
        hidden.assign("segment", "Tumor"),
    ] == ["Model 1", "Segment 1", "Model 2", "Segment 2"]
    shown = NameAssigner()
    assert [
        shown.assign("model", "Skull\x07"),
        shown.assign("model", "\u200b"),  # nothing left: the substitute instead of an empty label
        shown.assign("segment", "Liver"),
    ] == ["Skull", "Model 2", "Liver"]
    with pytest.raises(ValueError):
        shown.assign("volume", "x")


def _segment(number: int, name: str) -> Entity:
    mrml_id = "vtkMRMLSegmentationNode1"
    return Entity(
        node_id=f"{mrml_id}/Segment_{number}",
        kind="segment",
        name=name,
        positions=np.array([[0.0, 0.0, 0.0], [0.01, 0.0, 0.0], [0.0, 0.0, -0.01]]),
        normals=np.tile([0.0, 1.0, 0.0], (3, 1)),
        indices=np.array([[0, 1, 2]]),
        color=(0.8, 0.3, 0.3),
        opacity=1.0,
        visible=True,
        mrml_id=mrml_id,
        segment_id=f"Segment_{number}",
    )


def _model(node_id: str, name: str) -> Entity:
    return Entity(
        node_id=node_id,
        kind="model",
        name=name,
        positions=np.array([[0.0, 0.0, 0.0], [0.01, 0.0, 0.0], [0.0, 0.0, -0.01]]),
        normals=np.tile([0.0, 1.0, 0.0], (3, 1)),
        indices=np.array([[0, 1, 2]]),
        color=(1.0, 0.5, 0.0),
        opacity=1.0,
        visible=True,
        mrml_id=node_id,
    )


@pytest.mark.parametrize("anonymize", [False, True])
def test_names_assigned_names_are_accepted_by_the_writer(anonymize):
    """The names reach the GLB unchanged; with anonymize the root says anonymizedNames: true (§7.3)."""
    assigner = NameAssigner(anonymize=anonymize)
    raw = ["Patient\u0007 Name  ", "x" * 80, "\u202e", None]
    entities = [
        _model(f"vtkMRMLModelNode{i + 1}", assigner.assign("model", n)) for i, n in enumerate(raw)
    ]
    entities += [
        _segment(1, assigner.assign("segment", "Wątroba Jana Kowalskiego")),
        _segment(2, assigner.assign("segment", "Tumor")),
    ]
    root = RootExtras(
        scene_version=1, profile="mobile", slicer_version="5.12.4", anonymized_names=anonymize
    )
    glb = write_glb(entities, root)
    gltf = GLTF2.load_from_bytes(glb)
    expected = (
        ["Model 1", "Model 2", "Model 3", "Model 4", "Segment 1", "Segment 2"]
        if anonymize
        else ["Patient Name", "x" * 64, "Model 3", "Model 4", "Wątroba Jana Kowalskiego", "Tumor"]
    )
    t_nodes = [gltf.nodes[i] for i in gltf.nodes[0].children]
    assert [t.name for t in t_nodes] == [t.extras["name"] for t in t_nodes] == expected
    assert gltf.nodes[0].extras["anonymizedNames"] is anonymize
    if anonymize:
        document = gltf.to_json()
        for original in ("Patient", "xxxxxxxx", "Kowalski", "Tumor"):
            assert original not in document and original.encode() not in glb


def test_names_imports_no_slicer_qt_or_vtk():
    """Criterion 3, checked on what the import really loads (stdlib + glb_writer, which brings numpy)."""
    code = (
        "import sys; sys.path.append(sys.argv[1]); import remoteview_core.names\n"
        "print(sorted({m.split('.')[0] for m in sys.modules} & "
        "{'vtk', 'vtkmodules', 'slicer', 'qt', 'ctk', 'jsonschema', 'websockets', 'segno'}))\n"
    )
    result = subprocess.run(
        [sys.executable, "-I", "-c", code, str(Path(names.__file__).parents[1])],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "[]"


def test_names_assigner_mode_is_fixed():
    assigner = NameAssigner(anonymize=True)
    with pytest.raises(AttributeError):
        assigner.anonymize = False  # type: ignore[misc]
    assert assigner.assign("model", "Jan Kowalski") == "Model 1"
