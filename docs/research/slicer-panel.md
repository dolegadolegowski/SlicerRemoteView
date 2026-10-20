# Research — the session panel's Slicer, CTK and Qt API (SLC-09)

Verified on 2026-10-20 in the sources of Slicer `v5.12.4` and of the CTK revision it builds
(`5056664a20a3d0a393bb6d91f040525581e0dcdf`, from `SuperBuild/External_CTK.cmake`). Nothing here could be run inside
Slicer (CLAUDE.md rule 10): the manual steps are `docs/testing/slicer.md` §2.

| Fact | Source |
|---|---|
| Scripted module widgets load their panel with `slicer.util.loadUI(self.resourcePath("UI/<Module>.ui"))`, add it to `self.layout` and get named children with `slicer.util.childWidgetVariables(uiWidget)`; buttons connect with `self.ui.<button>.connect("clicked(bool)", slot)` | [TemplateKey.py#L147-L173](https://github.com/Slicer/Slicer/blob/v5.12.4/Utilities/Templates/Modules/Scripted/TemplateKey.py#L147-L173) |
| `ScriptedLoadableModuleWidget.resourcePath(filename)` = `<module dir>/Resources/<filename>` (via `slicer.util.modulePath`) | [ScriptedLoadableModule.py#L112-L115](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicer/ScriptedLoadableModule.py#L112-L115) |
| `loadUI` raises `RuntimeError` for a missing file and loads with `qt.QUiLoader`; `childWidgetVariables` sets one attribute per child widget with a non-empty `name` | [util.py#L522-L575](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicer/util.py#L522-L575) |
| `slicer.util.settingsValue(key, default, converter, settings)` reads `qt.QSettings()` (Slicer's own settings file) and returns `default` when the key is absent | [util.py#L3662-L3669](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicer/util.py#L3662-L3669) |
| `slicer.util.reloadScriptedModule` (*Reload*) calls the old widget's `cleanup()`; `ScriptedLoadableModuleWidget.__init__` also connects the module's `moduleAboutToBeUnloaded` signal (application exit) to `cleanup()` | [util.py `reloadScriptedModule`](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicer/util.py), [ScriptedLoadableModule.py#L109-L131](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicer/ScriptedLoadableModule.py#L109-L131) |
| `ctkPathLineEdit` properties: `currentPath` (user property), `filters` (`Files`, `Readable`, …), `nameFilters`, `showHistoryButton`, `settingKey`; signal `currentPathChanged(QString)` | [ctkPathLineEdit.h#L67-L149](https://github.com/commontk/CTK/blob/5056664a20a3d0a393bb6d91f040525581e0dcdf/Libs/Widgets/ctkPathLineEdit.h#L67-L149), [#L250-L256](https://github.com/commontk/CTK/blob/5056664a20a3d0a393bb6d91f040525581e0dcdf/Libs/Widgets/ctkPathLineEdit.h#L250-L256) |
| `ctkCollapsibleButton` has a `collapsed` property; .ui files declare both CTK classes as `customwidget`s (the template does the same for `ctkCollapsibleButton`) | [ctkCollapsibleButton.h#L48](https://github.com/commontk/CTK/blob/5056664a20a3d0a393bb6d91f040525581e0dcdf/Libs/Widgets/ctkCollapsibleButton.h#L48), [TemplateKey.ui#L220-L243](https://github.com/Slicer/Slicer/blob/v5.12.4/Utilities/Templates/Modules/Scripted/Resources/UI/TemplateKey.ui#L220-L243) |
| Slicer 5.12.4 builds with Qt 5.15 by default or Qt 6.8 when `Qt6_DIR` is set; which one the official packages use is `[TODO verify]` — the panel uses only API present in both (`QSettings`, `QTimer`, `QFont::setLetterSpacing`, `QFont::setStyleHint`, `Qt::PlainText`) | [CMakeLists.txt#L196-L203](https://github.com/Slicer/Slicer/blob/v5.12.4/CMakeLists.txt#L196-L203) |

**Consequences in the panel:** `RemoteView.py` follows the template (no MRML widget, so no `setMRMLScene`); every
label of `RemoteView.ui` is `Qt::PlainText` (relay data never becomes rich text); the relay address and the CA path are
plain `QSettings` values written only after the transport accepted them; `cleanup()` closes a running session, which
covers *Reload* and application exit.

## Not verified

- The PythonQt binding of `QFont.setLetterSpacing`/`setStyleHint` and the look of the code label (manual §2).
- Whether `QSettings` values written from Python reach Slicer's settings file on every OS (manual §2, step 6).
