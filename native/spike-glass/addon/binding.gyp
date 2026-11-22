{
  "targets": [
    {
      "target_name": "harbor_spike",
      "sources": [
        "spike_addon.cpp"
      ],
      "include_dirs": [
        "../src",
        "../../harbor-glass/include"
      ],
      "libraries": [
        "d3d11.lib",
        "dxgi.lib",
        "dcomp.lib",
        "dwmapi.lib",
        "user32.lib",
        "gdi32.lib",
        "psapi.lib",
        "ole32.lib",
        "dxguid.lib"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": [
            "/std:c++20",
            "/utf-8",
            "/EHsc"
          ]
        }
      }
    }
  ]
}
