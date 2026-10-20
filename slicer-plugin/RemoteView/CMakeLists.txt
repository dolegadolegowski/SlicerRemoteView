#-----------------------------------------------------------------------------
set(MODULE_NAME RemoteView)

# Every file under RemoteView/ must be listed below (Python files in SCRIPTS, everything else in
# RESOURCES) so the installed module is self-contained; tests/test_skeleton.py compares these lists
# with the source tree. _vendor/ is the copy of shared/py made by slicer-plugin/scripts/vendor_shared.py.

#-----------------------------------------------------------------------------
set(MODULE_PYTHON_SCRIPTS
  ${MODULE_NAME}.py
  remoteview_core/__init__.py
  remoteview_core/collect.py
  remoteview_core/coords.py
  remoteview_core/glb_writer.py
  remoteview_core/names.py
  remoteview_core/protocol_client.py
  remoteview_core/transport.py
  remoteview_core/vendored.py
  _vendor/remoteview_protocol/__init__.py
  _vendor/remoteview_protocol/alphabet.py
  _vendor/remoteview_protocol/chunk_header.py
  _vendor/remoteview_protocol/envelope.py
  _vendor/remoteview_protocol/generated.py
  _vendor/remoteview_protocol/schemas.py
  )

set(MODULE_PYTHON_RESOURCES
  Resources/Icons/${MODULE_NAME}.png
  _vendor/remoteview_protocol/VENDORED.json
  _vendor/remoteview_protocol/py.typed
  _vendor/remoteview_protocol/schema/defs.schema.json
  _vendor/remoteview_protocol/schema/envelope.schema.json
  _vendor/remoteview_protocol/schema/error.schema.json
  _vendor/remoteview_protocol/schema/ping.schema.json
  _vendor/remoteview_protocol/schema/pong.schema.json
  _vendor/remoteview_protocol/schema/scene.nodeAdded.schema.json
  _vendor/remoteview_protocol/schema/scene.nodeRemoved.schema.json
  _vendor/remoteview_protocol/schema/scene.request.schema.json
  _vendor/remoteview_protocol/schema/scene.snapshot.abort.schema.json
  _vendor/remoteview_protocol/schema/scene.snapshot.ack.schema.json
  _vendor/remoteview_protocol/schema/scene.snapshot.begin.schema.json
  _vendor/remoteview_protocol/schema/scene.snapshot.end.schema.json
  _vendor/remoteview_protocol/schema/scene.snapshot.ready.schema.json
  _vendor/remoteview_protocol/schema/scene.state.schema.json
  _vendor/remoteview_protocol/schema/scene.update.schema.json
  _vendor/remoteview_protocol/schema/session.close.schema.json
  _vendor/remoteview_protocol/schema/session.closed.schema.json
  _vendor/remoteview_protocol/schema/session.create.schema.json
  _vendor/remoteview_protocol/schema/session.created.schema.json
  _vendor/remoteview_protocol/schema/session.expired.schema.json
  _vendor/remoteview_protocol/schema/session.expiring.schema.json
  _vendor/remoteview_protocol/schema/session.publisherState.schema.json
  _vendor/remoteview_protocol/schema/session.renew.schema.json
  _vendor/remoteview_protocol/schema/session.renewed.schema.json
  _vendor/remoteview_protocol/schema/session.resume.schema.json
  _vendor/remoteview_protocol/schema/session.resumed.schema.json
  _vendor/remoteview_protocol/schema/viewer.count.schema.json
  _vendor/remoteview_protocol/schema/viewer.join.schema.json
  _vendor/remoteview_protocol/schema/viewer.joined.schema.json
  _vendor/remoteview_protocol/schema/viewer.leave.schema.json
  )

#-----------------------------------------------------------------------------
slicerMacroBuildScriptedModule(
  NAME ${MODULE_NAME}
  SCRIPTS ${MODULE_PYTHON_SCRIPTS}
  RESOURCES ${MODULE_PYTHON_RESOURCES}
  WITH_GENERIC_TESTS
  )

# slicer_add_python_unittest(SCRIPT ${MODULE_NAME}.py) wiring: SLC-19 (module self-test).
