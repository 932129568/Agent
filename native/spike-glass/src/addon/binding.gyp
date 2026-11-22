{
  "targets": [
    {
      "target_name": "harbor_osr",
      "sources": [
        "addon.cpp",
        "../osr_bridge.cpp",
        "../osr_host.cpp"
      ],
      "include_dirs": [
        ".."
      ],
      "defines": [
        "NAPI_VERSION=8"
      ],
      "libraries": [
        "d3d11.lib",
        "dxgi.lib",
        "dcomp.lib",
        "d3dcompiler.lib",
        "user32.lib",
        "gdi32.lib",
        "ole32.lib"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": [
            "/std:c++20",
            "/utf-8"
          ]
        }
      }
    }
  ]
}
