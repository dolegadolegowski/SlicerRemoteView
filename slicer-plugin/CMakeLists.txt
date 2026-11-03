# The modules of the RemoteView extension. The extension's top level — its name, the EXTENSION_* metadata, Slicer's
# use file and the packaging — is the repository root's CMakeLists.txt, which adds this directory (ADR 0010).
if(CMAKE_CURRENT_SOURCE_DIR STREQUAL CMAKE_SOURCE_DIR)
  message(FATAL_ERROR "Configure the repository root: its CMakeLists.txt is the top level of the RemoteView extension.")
endif()

add_subdirectory(RemoteView)
