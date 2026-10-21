cmake_minimum_required(VERSION 3.28.0...3.28.0 FATAL_ERROR)

# Layout follows the Slicer 5.12.4 extension template
# (Utilities/Templates/Extensions/Default/CMakeLists.txt at tag v5.12.4).
project(SlicerRemoteView)

#-----------------------------------------------------------------------------
# Extension meta-information
set(EXTENSION_HOMEPAGE "https://github.com/dolegadolegowski/SlicerRemoteView")
# The Extension Index category is authoritative in SlicerRemoteView.json (SLC-20); kept here for the
# generated extension description.
set(EXTENSION_CATEGORY "Remote")
set(EXTENSION_CONTRIBUTORS "SlicerRemoteView contributors")
set(EXTENSION_DESCRIPTION "Share the 3D Slicer scene with phones, tablets and Meta Quest headsets through a relay server and a 5-character session code. Nothing is sent until the user clicks Start session.")
set(EXTENSION_ICONURL "https://raw.githubusercontent.com/dolegadolegowski/SlicerRemoteView/main/slicer-plugin/RemoteView/Resources/Icons/RemoteView.png")
set(EXTENSION_SCREENSHOTURLS "") # [TODO] screenshot with SLC-20
set(EXTENSION_DEPENDS "NA") # Specified as a list or "NA" if no dependencies

#-----------------------------------------------------------------------------
# Extension dependencies
find_package(Slicer REQUIRED)
include(${Slicer_USE_FILE})

#-----------------------------------------------------------------------------
# Extension modules
add_subdirectory(RemoteView)
## NEXT_MODULE

#-----------------------------------------------------------------------------
include(${Slicer_EXTENSION_GENERATE_CONFIG})
include(${Slicer_EXTENSION_CPACK})
