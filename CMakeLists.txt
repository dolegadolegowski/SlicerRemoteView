cmake_minimum_required(VERSION 3.28.0...3.28.0 FATAL_ERROR)

# The RemoteView extension of 3D Slicer. Its top level sits at the repository root because the Slicer Extensions
# Index and the extensions build system configure the root of the clone, while its module lives in slicer-plugin/
# (ADR 0010). Layout of the Slicer 5.12.4 extension template
# (Utilities/Templates/Extensions/Default/CMakeLists.txt at tag v5.12.4).
project(RemoteView)

#-----------------------------------------------------------------------------
# Extension meta-information: the only copy (slicer-plugin/tests/test_package.py checks RemoteView.json, the module's
# contributors and the index CI's reading of these lines against it).
# The extension's page: slicer-plugin/README.md as GitHub shows it (name, description, screenshot, licence).
set(EXTENSION_HOMEPAGE "https://github.com/dolegadolegowski/SlicerRemoteView/tree/main/slicer-plugin")
# The Extensions Index category is authoritative in slicer-plugin/RemoteView.json; kept here for the generated
# extension description.
set(EXTENSION_CATEGORY "Remote")
set(EXTENSION_CONTRIBUTORS "Damian Dołęga-Dołęgowski (SlicerRemoteView)")
set(EXTENSION_DESCRIPTION "Share the 3D Slicer scene with phones, tablets and Meta Quest headsets through a relay server and a 5-character session code. Nothing is sent until the user clicks Start session.")
set(EXTENSION_ICONURL "https://raw.githubusercontent.com/dolegadolegowski/SlicerRemoteView/main/slicer-plugin/RemoteView/Resources/Icons/RemoteView.png")
# Space-separated raw image URLs (Extensions Index CI: no space before the closing parenthesis).
set(EXTENSION_SCREENSHOTURLS "https://raw.githubusercontent.com/dolegadolegowski/SlicerRemoteView/main/slicer-plugin/Screenshots/RemoteView-panel.png")
set(EXTENSION_DEPENDS "NA") # Specified as a list or "NA" if no dependencies

#-----------------------------------------------------------------------------
# Extension dependencies
find_package(Slicer REQUIRED)
include(${Slicer_USE_FILE})

#-----------------------------------------------------------------------------
# Extension modules: slicer-plugin/CMakeLists.txt adds them
add_subdirectory(slicer-plugin)

#-----------------------------------------------------------------------------
include(${Slicer_EXTENSION_GENERATE_CONFIG})
include(${Slicer_EXTENSION_CPACK})
