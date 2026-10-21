"""SLC-10: runtime dependencies on first use — the decision, the consent, the panel hook and the Slicer adapter."""

from __future__ import annotations

import importlib
import logging
import re
import subprocess
import sys
import types
from subprocess import CalledProcessError

import pytest
from conftest import MODULE_DIR
from support import URL, FakeTransport, parent_widget

from remoteview_core import deps, panel
from remoteview_core.deps import DepsResult, Outcome, Package, ensure_runtime_deps
from remoteview_core.panel import PanelController, PanelView

PLUGIN_ROOT = MODULE_DIR.parent
WS, SEGNO = deps.PACKAGES
SECRET = "http://operator:hunter2@proxy.hospital.example:3128"  # noqa: S105 — a fake proxy URL for the leak checks


class Recorder:
    """The two collaborators of ``ensure_runtime_deps``: what they were asked, and what they answer."""

    def __init__(
        self, versions: dict[str, str], *, agree: bool = True, error: Exception | None = None
    ) -> None:
        self.versions = versions
        self.agree = agree
        self.error = error
        self.installs: list[list[str]] = []
        self.dialogs: list[tuple[str, str]] = []

    def confirm(self, message: str, details: str) -> bool:
        self.dialogs.append((message, details))
        return self.agree

    def install(self, requirements: list[str]) -> None:
        self.installs.append(requirements)
        if self.error is not None:
            raise self.error
        for requirement in requirements:
            name, _, version = requirement.partition("==")
            self.versions[name] = version

    def run(self, **kwargs) -> DepsResult:
        return ensure_runtime_deps(
            self.install, self.confirm, installed=self.versions.get, **kwargs
        )


# --------------------------------------------------------------------------- the decision


def test_deps_pins_are_exact_and_websockets_is_the_tested_release():
    assert [(p.name, p.version) for p in deps.PACKAGES] == [
        ("websockets", "17.2"),
        ("segno", "1.6.6"),
    ]
    assert [p.requirement for p in deps.PACKAGES] == ["websockets==17.2", "segno==1.6.6"]
    # the version the dev environment (and so every test) runs is the one the module installs
    pinned = (PLUGIN_ROOT / "requirements-dev.txt").read_text().splitlines()
    assert "websockets==17.2" in pinned


@pytest.mark.parametrize(
    ("installed", "missing"),
    [
        ({}, ["websockets", "segno"]),
        ({"websockets": "17.2", "segno": "1.6.6"}, []),
        ({"websockets": "17.2"}, ["segno"]),
        ({"segno": "1.6.6"}, ["websockets"]),
        # another version counts as missing, older or newer: exact pins (T12)
        ({"websockets": "16.0", "segno": "1.6.6"}, ["websockets"]),
        ({"websockets": "17.3", "segno": "1.6.6"}, ["websockets"]),
        ({"websockets": "17.2", "segno": "1.6.7"}, ["segno"]),
        ({"websockets": "17.2", "segno": "1.6"}, ["segno"]),
    ],
)
def test_deps_missing_packages_by_exact_version(installed, missing):
    assert [p.name for p in deps.missing_packages(deps.PACKAGES, installed.get)] == missing


@pytest.mark.parametrize(
    "version", ["17.2", "17.2.0", "17.2.0.0", "17.02", "17.2+local", "17.2.0+ubuntu1"]
)
def test_deps_the_same_release_written_differently_counts_as_installed(version):
    assert deps.missing_packages([WS], {"websockets": version}.get) == []
    assert deps.stale_modules([WS], {"websockets": version}.get) == []


@pytest.mark.parametrize(
    "version",
    [
        "17.2.1",
        "17.20",
        "17",
        "17.2rc1",
        "17.2.post1",
        "17.3+local",
        "",
        "17.\u00b2",
        "\u0661\u0667.\u0662",
        pytest.param("17." + "9" * 5000, id="segment-too-long-for-int"),
    ],
)
def test_deps_other_releases_do_not_count_as_installed(version):
    assert deps.missing_packages([WS], {"websockets": version}.get) == [WS]


def test_deps_an_import_name_that_differs_from_the_distribution_name_is_used_for_the_loaded_check():
    yaml = Package("PyYAML", "6.0", "configuration", module="yaml")
    assert yaml.module_name == "yaml" and WS.module_name == "websockets"
    assert deps.stale_modules([yaml], {"yaml": "5.4"}.get) == [yaml]
    assert (
        deps.stale_modules([yaml], {"PyYAML": "5.4"}.get) == []
    )  # asked by import name, not by distribution name


def test_deps_a_result_that_stops_the_session_needs_a_text():
    with pytest.raises(ValueError, match="needs a text"):
        DepsResult(Outcome.DECLINED)
    assert DepsResult(Outcome.READY).detail == ""


@pytest.mark.parametrize(
    ("loaded", "stale"),
    [
        ({}, []),
        ({"websockets": "17.2", "segno": "1.6.6"}, []),
        ({"websockets": "16.0"}, ["websockets"]),
        ({"websockets": "17.2", "segno": "1.5.3"}, ["segno"]),
    ],
)
def test_deps_stale_modules_are_those_loaded_in_another_version(loaded, stale):
    assert [p.name for p in deps.stale_modules(deps.PACKAGES, loaded.get)] == stale


def test_deps_installed_and_loaded_versions_of_real_modules(monkeypatch):
    import websockets  # noqa: PLC0415 — pinned by requirements-dev.txt

    assert (
        deps.installed_version("websockets")
        == "17.2"
        == deps.loaded_version("websockets")
        == websockets.__version__
    )
    assert deps.installed_version("remoteview-no-such-distribution") is None
    assert deps.loaded_version("remoteview_no_such_module") is None
    monkeypatch.setitem(sys.modules, "versionless", types.ModuleType("versionless"))
    assert deps.loaded_version("versionless") is None
    odd = types.ModuleType("odd_version")
    odd.__version__ = (1, 2)
    monkeypatch.setitem(sys.modules, "odd_version", odd)
    assert deps.loaded_version("odd_version") is None


def test_deps_module_imports_nothing_that_installs_or_connects():
    code = (
        "import sys; sys.path.insert(0, sys.argv[1]);\n"
        "import remoteview_core.deps\n"
        "bad = {'websockets', 'segno', 'slicer', 'qt', 'pip', 'urllib.request'} & set(sys.modules)\n"
        "print(sorted(bad))"
    )
    result = subprocess.run(
        [sys.executable, "-I", "-c", code, str(MODULE_DIR)],
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    assert result.stdout.strip() == "[]"


# --------------------------------------------------------------------------- the dialog text


def test_deps_consent_text_names_packages_versions_purpose_and_source():
    message, details = deps.consent_text([WS, SEGNO], {}.get)
    for text in (
        "websockets 17.2",
        "segno 1.6.6",
        "the secure connection to the relay",
        "the QR code",
        "PyPI",
    ):
        assert text in message
    assert details == "websockets==17.2\nsegno==1.6.6"
    assert "Installed now" not in message  # nothing is installed yet
    # what the index sees, and that the scene is not part of it; the question is the last thing said
    assert "package index configured for pip" in message and "nothing from your scene" in message
    assert message.endswith("Install now?")


def test_deps_consent_text_says_which_installed_version_is_replaced_or_downgraded():
    message, details = deps.consent_text([WS], {"websockets": "16.0", "segno": "1.6.6"}.get)
    assert "Installed now:\n  • websockets 16.0 will be replaced by 17.2" in message
    assert "segno" not in message.split("Installed now")[1] and details == "websockets==17.2"
    assert message.endswith("Install now?") and "Other extensions" in message
    newer, _ = deps.consent_text([WS], {"websockets": "17.3"}.get)
    assert "websockets 17.3 will be downgraded to 17.2" in newer
    odd, _ = deps.consent_text([WS], {"websockets": "17.2rc1"}.get)
    assert (
        "websockets 17.2rc1 will be replaced by 17.2" in odd
    )  # not a plain number: no claim about the direction


def test_deps_texts_give_the_user_a_next_step():
    # criterion 3: a clear error with next steps — the texts are what the user reads, so their content is pinned
    for text in (deps.FAILED, deps.INCOMPLETE):
        assert "Start session" in text and "project page" in text
        assert (
            "Offline installation of the Python packages" in text
            and "slicer-plugin/README.md" in text
        )
    assert (
        "pypi.org" in deps.FAILED
        and "files.pythonhosted.org" in deps.FAILED
        and "proxy" in deps.FAILED
    )
    assert (
        "Nothing was installed or changed" in deps.DECLINED
        and "Start session again" in deps.DECLINED
    )
    restart = deps.RESTART.format(names="websockets")
    assert (
        "Restart Slicer" in restart and "Start session again" in restart and "websockets" in restart
    )
    # true when nothing was installed, too (the right release was already on disk)
    assert "in place" in restart and "RemoteView installed" not in restart
    assert "Offline installation of the Python packages" in panel.WEBSOCKETS_MISSING
    assert "slicer-plugin/README.md" in panel.WEBSOCKETS_MISSING
    # the README has the section the texts name, with the list form of the command (Windows paths)
    readme = (PLUGIN_ROOT / "README.md").read_text()
    assert "## Offline installation of the Python packages" in readme
    command = re.search(r"slicer\.util\.pip_install\(\s*\[(.*?)\]\s*\)", readme, re.DOTALL)
    assert (
        command is not None
    )  # the list form: a string would lose the backslashes of a Windows path
    arguments = re.findall(r'r?"([^"]*)"', command.group(1))
    assert arguments[:2] == ["--no-index", "--find-links"]
    assert "--only-binary" in arguments and arguments[-2:] == [p.requirement for p in deps.PACKAGES]


# --------------------------------------------------------------------------- the sequence


def test_deps_everything_present_asks_and_installs_nothing():
    recorder = Recorder({"websockets": "17.2", "segno": "1.6.6"})
    assert recorder.run(loaded=lambda _name: None) == DepsResult(Outcome.READY)
    assert recorder.dialogs == [] and recorder.installs == []


def test_deps_installs_only_what_is_missing_after_the_user_agrees():
    recorder = Recorder({"websockets": "17.2"})
    assert recorder.run(loaded=lambda _name: None) == DepsResult(Outcome.READY)
    assert len(recorder.dialogs) == 1 and recorder.installs == [["segno==1.6.6"]]
    assert recorder.dialogs[0][1] == "segno==1.6.6"
    # the second Start asks nothing (FR-16)
    assert recorder.run(loaded=lambda _name: None) == DepsResult(Outcome.READY)
    assert len(recorder.dialogs) == 1 and len(recorder.installs) == 1


def test_deps_declining_installs_nothing():
    recorder = Recorder({}, agree=False)
    assert recorder.run() == DepsResult(Outcome.DECLINED, deps.DECLINED)
    assert recorder.installs == []


def test_deps_replaces_another_installed_version_after_consent():
    recorder = Recorder({"websockets": "16.0", "segno": "1.6.6"})
    assert recorder.run(loaded=lambda _name: None) == DepsResult(Outcome.READY)
    assert recorder.installs == [["websockets==17.2"]]
    assert "websockets 16.0" in recorder.dialogs[0][0]


def test_deps_failure_is_a_fixed_text_that_never_carries_the_installers_message(caplog):
    error = CalledProcessError(1, ["pip", "install", "--proxy", SECRET, "websockets==17.2"])
    recorder = Recorder({}, error=error)
    with caplog.at_level(logging.DEBUG):
        result = recorder.run()
    assert result == DepsResult(Outcome.FAILED, deps.FAILED)
    assert "hunter2" not in result.detail and "hunter2" not in caplog.text
    assert "CalledProcessError" in caplog.text  # the type is logged, nothing else


def test_deps_any_installer_error_is_a_failure_but_an_interrupt_is_not_swallowed():
    assert Recorder({}, error=OSError("disk full")).run().outcome is Outcome.FAILED
    assert (
        Recorder({}, error=RuntimeError("User declined package installation")).run().outcome
        is Outcome.FAILED
    )
    with pytest.raises(KeyboardInterrupt):
        Recorder({}, error=KeyboardInterrupt()).run()


def test_deps_an_installer_that_installed_nothing_is_reported_not_trusted():
    # Slicer's testing mode makes pip_ensure return without installing (skip_in_testing)
    recorder = Recorder({})
    recorder.install = recorder.installs.append  # type: ignore[method-assign]
    assert recorder.run() == DepsResult(Outcome.FAILED, deps.INCOMPLETE)


def test_deps_clears_the_import_caches_after_installing(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(importlib, "invalidate_caches", lambda: calls.append("invalidate"))
    recorder = Recorder({})
    original = recorder.install
    recorder.install = lambda requirements: (calls.append("install"), original(requirements))[1]  # type: ignore[method-assign]
    assert recorder.run(loaded=lambda _name: None).outcome is Outcome.READY
    assert calls == [
        "install",
        "invalidate",
    ]  # a package that is not on disk yet cannot be found by the import system


def test_deps_a_module_loaded_in_another_version_needs_a_restart():
    recorder = Recorder({"websockets": "16.0", "segno": "1.6.6"})
    result = recorder.run(loaded={"websockets": "16.0"}.get)
    assert result.outcome is Outcome.RESTART and result.detail == deps.RESTART.format(
        names="websockets"
    )
    assert recorder.installs == [
        ["websockets==17.2"]
    ]  # installed first: the restart then finds the right version
    # on disk already right, but the old one is still loaded: no dialog, just the restart text
    quiet = Recorder({"websockets": "17.2", "segno": "1.6.6"})
    assert quiet.run(loaded={"websockets": "16.0", "segno": "1.6.6"}.get).outcome is Outcome.RESTART
    assert quiet.dialogs == [] and quiet.installs == []


def test_deps_the_default_loaded_check_reads_the_modules_of_this_session(monkeypatch):
    # what production runs: nothing injected, sys.modules says websockets 16.0 is imported
    old = types.ModuleType("websockets")
    old.__version__ = "16.0"
    monkeypatch.setitem(sys.modules, "websockets", old)
    recorder = Recorder({"websockets": "17.2", "segno": "1.6.6"})
    result = ensure_runtime_deps(
        recorder.install, recorder.confirm, installed=recorder.versions.get
    )
    assert result.outcome is Outcome.RESTART and "websockets" in result.detail
    assert (
        recorder.dialogs == [] and recorder.installs == []
    )  # on disk it is right: nothing to ask, only a restart


def test_deps_custom_package_lists_are_decided_by_their_own_pins():
    extra = (*deps.PACKAGES, Package("other", "2.0", "something else"))
    recorder = Recorder({"websockets": "17.2", "segno": "1.6.6"})
    assert recorder.run(packages=extra, loaded=lambda _name: None).outcome is Outcome.READY
    assert recorder.installs == [["other==2.0"]]


# --------------------------------------------------------------------------- the panel controller


def controller(ensure) -> PanelController:
    return PanelController(
        slicer_version="5.12.4",
        platform="win32",
        transport_factory=FakeTransport,
        ensure_deps=ensure,
    )


def test_panel_ensure_deps_runs_after_the_address_is_accepted_and_before_the_transport_starts(fake):
    order: list[str] = []

    def ensure() -> DepsResult:
        order.append("deps")
        assert [t.started for t in fake.made] == [
            False
        ]  # the transport exists and is checked, but does not run
        return DepsResult(Outcome.READY)

    ctl = controller(ensure)
    view = ctl.start(URL)
    assert order == ["deps"] and fake.made[0].started and ctl.active
    assert view.status == "Connecting to relay.example.org…"


@pytest.mark.parametrize(
    "result",
    [
        DepsResult(Outcome.DECLINED, deps.DECLINED),
        DepsResult(Outcome.FAILED, deps.FAILED),
        DepsResult(Outcome.RESTART, deps.RESTART.format(names="websockets")),
    ],
)
def test_panel_a_deps_problem_ends_the_attempt_with_its_text(fake, result):
    answers = iter([result, DepsResult(Outcome.READY)])
    ctl = controller(lambda: next(answers))
    view = ctl.start(URL)
    assert not ctl.active and not fake.made[0].started
    assert view.status == panel.CANNOT_START and view.detail == result.detail and view.start_enabled
    assert ctl.phase is panel.Phase.IDLE
    # the same controller asks again at the next Start: nothing is remembered
    assert ctl.start(URL).status.startswith("Connecting") and fake.made[1].started


def test_panel_a_refused_address_is_refused_before_anything_is_installed(fake):
    called: list[str] = []
    ctl = controller(lambda: called.append("deps") or DepsResult(Outcome.READY))
    view = ctl.start("wss://user:secret@relay.example.org/ws")
    assert called == [] and view.status == panel.CANNOT_START and fake.made == []


def test_panel_no_second_start_while_the_packages_are_being_installed(fake):
    inner: list[PanelView] = []
    holder: list[PanelController] = []

    def ensure() -> DepsResult:
        # Qt's event loop runs inside the installation: a second click arrives here, and its view is rendered
        inner.append(holder[0].start(URL))
        return DepsResult(Outcome.READY)

    ctl = controller(ensure)
    holder.append(ctl)
    ctl.start(URL)
    assert (
        len(fake.made) == 1 and fake.made[0].started and ctl.active
    )  # the inner click did nothing
    (view,) = inner
    assert (
        view.start_enabled is False and view.settings_enabled is False
    )  # and it keeps the panel locked


def test_panel_a_failing_ensure_deps_leaves_the_panel_as_it_was(fake):
    def boom() -> DepsResult:
        raise RuntimeError("unexpected")

    ctl = controller(boom)
    before = ctl.view
    with pytest.raises(RuntimeError, match="unexpected"):
        ctl.start(URL)
    assert ctl.view == before and ctl.view.start_enabled and ctl.phase is panel.Phase.IDLE
    ctl._ensure_deps = lambda: DepsResult(Outcome.READY)
    assert ctl.start(URL).status.startswith("Connecting")


def test_panel_without_ensure_deps_nothing_is_checked(fake):
    ctl = PanelController(
        slicer_version="5.12.4", platform="win32", transport_factory=FakeTransport
    )
    assert ctl.start(URL).status.startswith("Connecting")


def test_panel_a_broken_install_is_reported_when_the_transport_cannot_import_websockets(fake):
    class Unimportable(FakeTransport):
        def start(self) -> None:
            raise ImportError("No module named 'websockets'")

    ctl = PanelController(
        slicer_version="5.12.4",
        platform="win32",
        transport_factory=Unimportable,
        ensure_deps=lambda: DepsResult(Outcome.READY),
    )
    view = ctl.start(URL)
    assert view.detail == panel.WEBSOCKETS_MISSING and "ImportError" not in view.detail


# --------------------------------------------------------------------------- the Slicer adapter (against the stubs)


@pytest.fixture
def adapter(import_remote_view, monkeypatch, fake, packages_installed, slicer_stubs):
    """The widget with the stub Slicer: ``installed`` is what pip would have installed (starts empty)."""
    packages_installed.clear()  # a fresh profile: opening the panel below must not find (or install) anything
    module = import_remote_view()
    monkeypatch.setattr(panel, "RelayTransport", FakeTransport)
    instance = module.RemoteViewWidget(parent=parent_widget())
    instance.setup()
    instance.ui.relayUrlLineEdit.text = URL
    instance.ui.extraCaPathLineEdit.currentPath = ""

    def pip_ensure(requirements, **_kwargs) -> None:
        for requirement in requirements:
            name, _, version = requirement.partition("==")
            packages_installed[name] = version

    slicer_stubs["slicer.packaging"].pip_ensure.side_effect = pip_ensure
    return types.SimpleNamespace(
        instance=instance, installed=packages_installed, stubs=slicer_stubs, module=module
    )


def test_adapter_opening_the_panel_installs_and_asks_nothing(adapter):
    stubs = adapter.stubs
    assert stubs["slicer.util"].confirmOkCancelDisplay.call_count == 0
    assert stubs["slicer.packaging"].pip_ensure.call_count == 0
    assert (
        stubs["slicer.packaging"].pip_install.call_count == 0
        and stubs["slicer.util"].pip_install.call_count == 0
    )


def test_adapter_start_asks_first_then_installs_with_slicers_pip_and_connects(adapter):
    stubs = adapter.stubs
    ui = adapter.instance.ui
    dialog: list[bool] = []

    def agree(*_args, **_kwargs) -> bool:
        # the dialog is open: the panel is locked, and a second click does not unlock it
        locked = ui.startButton.enabled
        adapter.instance.onStartClicked()
        dialog.append((locked, ui.startButton.enabled))
        return True

    stubs["slicer.util"].confirmOkCancelDisplay.side_effect = agree
    adapter.instance.onStartClicked()
    confirm = stubs["slicer.util"].confirmOkCancelDisplay
    (message, title), kwargs = confirm.call_args
    assert dialog == [(False, False)] and confirm.call_count == 1
    assert title == deps.CONFIRM_TITLE and "PyPI" in message and "websockets 17.2" in message
    assert kwargs == {"detailedText": "websockets==17.2\nsegno==1.6.6"}
    stubs["slicer.packaging"].pip_ensure.assert_called_once_with(
        ["websockets==17.2", "segno==1.6.6"],
        prompt_install=False,  # our dialog was the question
        prompt_restart=False,  # our result text covers a package that was loaded before
        requester="RemoteView",
    )
    assert ui.statusLabel.text == "Connecting to relay.example.org…"
    assert adapter.instance.pumpTimer.isActive()
    # the second Start asks nothing
    adapter.instance.onStopClicked()
    FakeTransport.made[-1].events.put(panel.Disconnected(None, None, None))
    adapter.instance.onPump()
    adapter.instance.onStartClicked()
    assert confirm.call_count == 1 and stubs["slicer.packaging"].pip_ensure.call_count == 1


def test_adapter_declining_installs_nothing_and_says_so(adapter):
    stubs = adapter.stubs
    stubs["slicer.util"].confirmOkCancelDisplay.return_value = False
    adapter.instance.onStartClicked()
    assert stubs["slicer.packaging"].pip_ensure.call_count == 0
    ui = adapter.instance.ui
    assert ui.statusLabel.text == panel.CANNOT_START and ui.detailLabel.text == deps.DECLINED
    assert ui.startButton.enabled is True and not adapter.instance.pumpTimer.isActive()
    # nothing about the attempt is remembered
    assert not stubs["qt"].QSettings().contains("RemoteView/RelayURL")


def test_adapter_a_pip_failure_shows_guidance_and_leaks_nothing(adapter, caplog):
    stubs = adapter.stubs
    stubs["slicer.packaging"].pip_ensure.side_effect = CalledProcessError(
        1, f"pip install --proxy {SECRET}"
    )
    with caplog.at_level(logging.DEBUG):
        adapter.instance.onStartClicked()
    ui = adapter.instance.ui
    assert ui.detailLabel.text == deps.FAILED and ui.statusLabel.text == panel.CANNOT_START
    assert "hunter2" not in ui.detailLabel.text + ui.statusLabel.text + caplog.text
    assert ui.startButton.enabled is True and FakeTransport.made[0].started is False


def test_adapter_a_refused_address_installs_nothing(adapter):
    adapter.instance.ui.relayUrlLineEdit.text = (
        "ws://relay.example.org/ws"  # plain ws:// is loopback-only (§3.1)
    )
    adapter.instance.onStartClicked()
    stubs = adapter.stubs
    assert stubs["slicer.util"].confirmOkCancelDisplay.call_count == 0
    assert stubs["slicer.packaging"].pip_ensure.call_count == 0
    assert adapter.instance.ui.statusLabel.text == panel.CANNOT_START


def test_adapter_slicer_without_the_packaging_module_ends_with_the_fixed_text(
    adapter, monkeypatch, caplog
):
    stubs = adapter.stubs
    monkeypatch.delitem(sys.modules, "slicer.packaging")
    delattr(stubs["slicer"], "packaging")
    with caplog.at_level(logging.DEBUG):
        adapter.instance.onStartClicked()
    ui = adapter.instance.ui
    # Slicer 5.12 is the supported range (NFR-24): an older one reports the failure, it does not guess
    assert ui.detailLabel.text == deps.FAILED and ui.startButton.enabled is True
    assert stubs["slicer.util"].pip_install.call_count == 0 and "ImportError" in caplog.text


def test_adapter_a_failing_dialog_leaves_start_enabled_and_asks_again_next_time(adapter):
    stubs = adapter.stubs
    confirm = stubs["slicer.util"].confirmOkCancelDisplay
    confirm.side_effect = RuntimeError("Qt boom")
    with pytest.raises(RuntimeError, match="Qt boom"):
        adapter.instance.onStartClicked()
    assert (
        adapter.instance.ui.startButton.enabled is True
        and not adapter.instance.pumpTimer.isActive()
    )
    confirm.side_effect = None
    adapter.instance.onStartClicked()
    assert confirm.call_count == 2 and adapter.instance.ui.statusLabel.text.startswith("Connecting")


@pytest.mark.parametrize("answer", [False, "fail"])
def test_adapter_after_a_no_or_a_failure_the_next_start_asks_again(adapter, answer):
    stubs = adapter.stubs
    confirm = stubs["slicer.util"].confirmOkCancelDisplay
    pip_ensure = stubs["slicer.packaging"].pip_ensure
    working = pip_ensure.side_effect
    if answer == "fail":
        pip_ensure.side_effect = CalledProcessError(1, "pip install")
    else:
        confirm.return_value = False
    adapter.instance.onStartClicked()
    assert adapter.instance.ui.statusLabel.text == panel.CANNOT_START and confirm.call_count == 1
    confirm.return_value = True
    pip_ensure.side_effect = working
    adapter.instance.onStartClicked()
    assert confirm.call_count == 2 and adapter.instance.ui.statusLabel.text.startswith("Connecting")


def test_adapter_an_installer_that_skips_is_reported_as_incomplete(adapter):
    # Slicer's confirm dialogs answer "yes" in testing mode and pip_ensure then skips the installation: the sequence
    # must end in the explicit "still missing" text, never in a half-started session
    adapter.stubs["slicer.packaging"].pip_ensure.side_effect = lambda *_a, **_k: None
    adapter.instance.onStartClicked()
    assert adapter.instance.ui.detailLabel.text == deps.INCOMPLETE
    assert FakeTransport.made[0].started is False


def test_adapter_declared_install_pins_match_the_module_list(adapter):
    adapter.instance.onStartClicked()
    ((requirements,), _kwargs) = adapter.stubs["slicer.packaging"].pip_ensure.call_args
    assert requirements == [p.requirement for p in deps.PACKAGES]
