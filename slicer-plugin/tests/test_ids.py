"""SLC-27: the raw ID → alias registry of protocol v1.1 §7.3 (report 2026-10-27-protocol-2 item 1, FR-64, T7)."""

from __future__ import annotations

from pathlib import Path

import pytest

from remoteview_core import ids as ids_module
from remoteview_core.ids import MAX_NODE_ID, SceneIds

SEG = "vtkMRMLSegmentationNode1"  # 24 characters
#: The report's four raw IDs: outside the nodeId set, or too long for it.
RAW_IDS = ["left lung", "Läsion", "Tumor(1)", "a" * 110]


def _alias(node_id: str) -> str:
    """The alias tail ``s_<n>`` of an aliased segment nodeId."""
    prefix, tail = node_id.rsplit("/", 1)
    assert prefix == SEG and tail.startswith("s_")
    return tail


# --------------------------------------------------------------------------- segments: aliases


def test_ids_segments_outside_the_grammar_get_aliases_in_first_sight_order():
    ids = SceneIds()
    first = [ids.segment_node_id(SEG, raw, anonymize=False) for raw in RAW_IDS]
    assert first == [f"{SEG}/s_{n}" for n in (1, 2, 3, 4)]
    # the same raw ID asked again — in any order, any number of times — gives the same alias
    again = [ids.segment_node_id(SEG, raw, anonymize=False) for raw in reversed(RAW_IDS)]
    assert again == list(reversed(first))
    assert ids.segment_node_id(SEG, "left lung", anonymize=False) == f"{SEG}/s_1"
    assert ids.segment_node_id(SEG, "a" * 110, anonymize=False) == f"{SEG}/s_4"


def test_ids_the_reserved_namespace_is_aliased_and_never_collides():
    """§7.3: a raw segment ID ``s_<digits>`` is itself aliased, so no real segment can share an alias's nodeId."""
    ids = SceneIds()
    assert ids.segment_node_id(SEG, "left lung", anonymize=False) == f"{SEG}/s_1"
    assert ids.segment_node_id(SEG, "s_1", anonymize=False) == f"{SEG}/s_2"  # not the verbatim s_1
    assert ids.segment_node_id(SEG, "s_2", anonymize=False) == f"{SEG}/s_3"
    assert ids.segment_node_id(SEG, "s_", anonymize=False) == f"{SEG}/s_"  # not the reserved shape
    node_ids = [
        ids.segment_node_id(SEG, raw, anonymize=False)
        for raw in ("left lung", "s_1", "s_2", "Segment_1", "s_3", "s_99")
    ]
    assert len(set(node_ids)) == len(node_ids)


def test_ids_conforming_segment_ids_stay_verbatim():
    ids = SceneIds()
    for raw in ("Segment_1", "Liver_DoeJohn", "A.b:c-d", "1"):
        assert ids.segment_node_id(SEG, raw, anonymize=False) == f"{SEG}/{raw}"
    assert ids.segment_extra("Liver_DoeJohn", anonymize=False) == "Liver_DoeJohn"
    # verbatim IDs allocate nothing
    assert repr(ids).startswith("SceneIds(models=0, segments=0,")


def test_ids_node_id_length_boundary():
    """A verbatim nodeId may be exactly 128 characters (§3.3); one more and the segment is aliased."""
    ids = SceneIds()
    fits = "x" * (MAX_NODE_ID - len(SEG) - 1)  # 103 characters
    assert len(f"{SEG}/{fits}") == 128
    assert ids.segment_node_id(SEG, fits, anonymize=False) == f"{SEG}/{fits}"
    assert ids.segment_node_id(SEG, fits + "x", anonymize=False) == f"{SEG}/s_1"


def test_ids_a_slash_in_a_segment_id_is_aliased():
    """Stricter than §7.3 (which allows ``/`` in a nodeId): the ``<prefix>/<segment>`` split stays unambiguous."""
    ids = SceneIds()
    assert ids.segment_node_id(SEG, "a/b", anonymize=False) == f"{SEG}/s_1"
    assert ids.segment_extra("a/b", anonymize=False) == "a/b"


def test_ids_hide_node_names_aliases_every_segment_and_the_alias_is_kept():
    """D-a: once issued, an alias stays — also after *Hide node names* is switched off (§7.3 "never reissued or
    shadowed"); then ``extras.segmentId`` is revealed."""
    ids = SceneIds()
    hidden = [ids.segment_node_id(SEG, raw, anonymize=True) for raw in ("Segment_1", "left lung")]
    assert hidden == [f"{SEG}/s_1", f"{SEG}/s_2"]
    assert ids.segment_extra("Segment_1", anonymize=True) is None
    shown = [ids.segment_node_id(SEG, raw, anonymize=False) for raw in ("Segment_1", "left lung")]
    assert shown == hidden
    assert ids.segment_extra("Segment_1", anonymize=False) == "Segment_1"
    assert ids.segment_extra("left lung", anonymize=False) == "left lung"
    # a segment first seen with names shown keeps its verbatim nodeId while they are shown…
    assert ids.segment_node_id(SEG, "Segment_2", anonymize=False) == f"{SEG}/Segment_2"
    # …and is aliased once they are hidden; that alias then stays too
    assert ids.segment_node_id(SEG, "Segment_2", anonymize=True) == f"{SEG}/s_3"
    assert ids.segment_node_id(SEG, "Segment_2", anonymize=False) == f"{SEG}/s_3"


def test_ids_bytes_segment_ids_are_aliased_and_decoded_for_the_extra():
    """VTK returns ``bytes`` for a segment ID that is not UTF-8 (a Latin-1 file): outside the set, so aliased; the
    extra is the UTF-8 decoding with U+FFFD."""
    ids = SceneIds()
    assert ids.segment_node_id(SEG, b"L\xe4sion", anonymize=False) == f"{SEG}/s_1"
    # bytes are never verbatim, and the str of the same characters is another key
    assert ids.segment_node_id(SEG, b"Segment_1", anonymize=False) == f"{SEG}/s_2"
    assert ids.segment_node_id(SEG, "Segment_1", anonymize=False) == f"{SEG}/Segment_1"
    assert ids.segment_extra(b"L\xe4sion", anonymize=False) == "L�sion"
    assert ids.segment_extra(b"L\xe4sion", anonymize=True) is None
    assert ids.segment_extra(b"Liver", anonymize=False) == "Liver"


def test_ids_segment_aliases_are_keyed_by_node_and_segment():
    ids = SceneIds()
    assert ids.segment_node_id(SEG, "left lung", anonymize=False) == f"{SEG}/s_1"
    assert ids.segment_node_id("vtkMRMLSegmentationNode2", "left lung", anonymize=False) == (
        "vtkMRMLSegmentationNode2/s_2"
    )
    # a segment of a node whose own ID is aliased
    assert ids.segment_node_id("Sphere", "Segment_1", anonymize=False) == "m_1/Segment_1"
    assert ids.segment_node_id("Sphere", "left lung", anonymize=False) == "m_1/s_3"
    assert ids.held_prefix("Sphere") == "m_1/"


@pytest.mark.parametrize("node_raw", [None, 3, ["vtkMRMLSegmentationNode1"]])
def test_ids_a_segmentation_node_without_a_string_id_has_no_segment_ids(node_raw):
    ids = SceneIds()
    assert ids.segment_node_id(node_raw, "Segment_1", anonymize=False) is None
    assert ids.held_prefix(node_raw) is None


@pytest.mark.parametrize("seg_raw", [None, 5, ("Segment_1",)])
def test_ids_a_segment_id_of_another_type_gives_none(seg_raw):
    """An adapter bug, never a Slicer state (``GetSegmentIDs`` gives str or bytes): the caller skips the segment."""
    ids = SceneIds()
    assert ids.segment_node_id(SEG, seg_raw, anonymize=False) is None
    assert ids.segment_extra(seg_raw, anonymize=False) is None
    assert repr(ids).startswith("SceneIds(models=0, segments=0,")


# --------------------------------------------------------------------------- models and segmentation nodes


def test_ids_generated_mrml_ids_stay_and_other_ids_become_m_aliases():
    ids = SceneIds()
    assert ids.model_node_id("vtkMRMLModelNode4") == "vtkMRMLModelNode4"
    assert ids.model_node_id("vtkMRMLSegmentationNode12") == "vtkMRMLSegmentationNode12"
    long_counter = "vtkMRMLModelNode12345678901"  # the contract regex has no digit cap
    assert ids.model_node_id(long_counter) == long_counter
    hand_set = ["Sphere", "root", "vtkMRMLModelNode1950010112x", "m_1", "a/b"]
    assert [ids.model_node_id(raw) for raw in hand_set] == ["m_1", "m_2", "m_3", "m_4", "m_5"]
    assert [ids.model_node_id(raw) for raw in hand_set] == ["m_1", "m_2", "m_3", "m_4", "m_5"]
    assert ids.model_node_id(None) is None and ids.model_node_id(3) is None
    assert ids.held_prefix("Sphere") == "m_1/" and ids.held_prefix("vtkMRMLModelNode4") == (
        "vtkMRMLModelNode4/"
    )
    assert ids.held_prefix(None) is None


@pytest.mark.parametrize(
    "raw",
    [
        "vtkMRMLModelNode",  # no counter
        "vtkMRMLModel7Node",
        "vtkMRMLModelNode7Kowalski",
        "vtkMRMLModelNode7.Jan",
        "vtkMRMLModelNode7\n",  # fullmatch: a trailing newline is not a generated ID
        " vtkMRMLModelNode7",
        "VTKMRMLModelNode7",
        # the generated shape but over the §3.3 length limit: aliased, not refused
        "vtkMRML" + "A" * 120 + "Node7",
        b"vtkMRMLModelNode7",  # bytes: VTK's wrapping for a non-UTF-8 ID
    ],
)
def test_ids_only_a_full_generated_shape_keeps_its_id(raw):
    ids = SceneIds()
    assert ids.model_node_id(raw) == "m_1"
    assert ids_module.is_generated_id(raw) is False


def test_ids_bytes_and_str_model_ids_are_different_keys():
    ids = SceneIds()
    assert ids.model_node_id("Sphere") == "m_1"
    assert ids.model_node_id(b"Sphere") == "m_2"
    assert ids.model_node_id("Sphere") == "m_1"


# --------------------------------------------------------------------------- reset and repr


def test_ids_reset_forgets_the_maps_and_never_reissues_a_number():
    """§7.3: the maps live for the Slicer scene's lifetime, the counters for the session — after a scene close the
    same raw IDs get fresh numbers, and no number issued before comes back."""
    ids = SceneIds()
    before_s = [_alias(ids.segment_node_id(SEG, raw, anonymize=False)) for raw in RAW_IDS]
    before_m = [ids.model_node_id(raw) for raw in ("Sphere", "root", "a/b", "m_1", "x y")]
    assert before_s == ["s_1", "s_2", "s_3", "s_4"] and before_m[-1] == "m_5"
    ids.reset()
    assert repr(ids) == "SceneIds(models=0, segments=0, next_m=6, next_s=5)"
    after_s = [_alias(ids.segment_node_id(SEG, raw, anonymize=False)) for raw in RAW_IDS]
    after_m = [ids.model_node_id(raw) for raw in ("Sphere", "root", "a/b", "m_1", "x y")]
    assert after_s == ["s_5", "s_6", "s_7", "s_8"]
    assert after_m == ["m_6", "m_7", "m_8", "m_9", "m_10"]
    assert not set(before_s) & set(after_s) and not set(before_m) & set(after_m)
    # the new numbers are as stable as the old ones were
    assert ids.segment_node_id(SEG, "left lung", anonymize=False) == f"{SEG}/s_5"
    assert ids.model_node_id("Sphere") == "m_6"
    # verbatim IDs are unaffected by a reset
    assert ids.segment_node_id(SEG, "Segment_1", anonymize=False) == f"{SEG}/Segment_1"
    assert ids.model_node_id("vtkMRMLModelNode4") == "vtkMRMLModelNode4"


def test_ids_repr_shows_counts_only():
    """A raw segment ID may be PHI (T7): the repr, which can reach a log, holds numbers only."""
    ids = SceneIds()
    ids.segment_node_id(SEG, "Doe John liver", anonymize=False)
    ids.segment_node_id(SEG, b"Doe\xe4", anonymize=False)
    ids.model_node_id("Doe_John_skull")
    text = repr(ids)
    assert text == "SceneIds(models=1, segments=2, next_m=2, next_s=3)"
    assert "Doe" not in text and SEG not in text


def test_ids_module_is_standard_library_only():
    """Pure core (CLAUDE.md rule 10; ``test_core_purity`` checks the whole package): nothing beyond ``re`` and
    ``threading`` (the generation's lock, SLC-70)."""
    source = Path(ids_module.__file__).read_text(encoding="utf-8")
    imports = [line for line in source.splitlines() if line.startswith(("import ", "from "))]
    assert imports == [
        "from __future__ import annotations",
        "import re",
        "import threading",
        "from typing import Any",
    ]
