#-----------------------------------------------------------------------------
set(MODULE_NAME RemoteView)

# Every file under RemoteView/ must be listed below (Python files in SCRIPTS, everything else in
# RESOURCES) so the installed module is self-contained; tests/test_skeleton.py compares these lists
# with the source tree.

#-----------------------------------------------------------------------------
set(MODULE_PYTHON_SCRIPTS
  ${MODULE_NAME}.py
  remoteview_core/__init__.py
  )

set(MODULE_PYTHON_RESOURCES
  Resources/Icons/${MODULE_NAME}.png
  )

#-----------------------------------------------------------------------------
slicerMacroBuildScriptedModule(
  NAME ${MODULE_NAME}
  SCRIPTS ${MODULE_PYTHON_SCRIPTS}
  RESOURCES ${MODULE_PYTHON_RESOURCES}
  WITH_GENERIC_TESTS
  )

# slicer_add_python_unittest(SCRIPT ${MODULE_NAME}.py) wiring: SLC-19 (module self-test).
