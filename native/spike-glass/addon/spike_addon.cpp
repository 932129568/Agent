// spike_addon.cpp -- Harbor v2.1 M2 spike addon (T01 minimal, T03 extends).
//
// T01 scope: this file exists so the *build chain* (node-gyp -> Electron N-API addon)
// is proven end to end. It is deliberately minimal but NOT empty: per R101 D3 an empty
// placeholder would pass "file exists" checks while proving nothing. Both exports below
// are really callable and return real data read at runtime:
//
//   hostVersion() -> non-empty string carrying electron/node/napi versions
//   probeSelf()   -> object carrying adapterLuid / dxgiAdapter / d3d11 feature level
//
// Why the include order matters: <windows.h> MUST come before <d3d11_1.h>, otherwise the
// DXGI/D3D headers miss HRESULT/IUnknown and emit a burst of misleading C2065/C2143.
// See native/spike-glass/src/osr_bridge.cpp L1-L3 for the same warning.
//
// Hard rules inherited from the probe work (native/build/m2probe/):
//   * every napi_* return value is checked; no C++ exception ever crosses the boundary
//   * binding.gyp must keep /utf-8, otherwise MSVC parses this file as GBK and the
//     trailing byte 0x5C of a CJK character swallows the next line (real incident)
//   * the addon must be built by node-gyp, never by a hand-rolled "cl /LD": node-gyp
//     links win_delay_load_hook.cc, and without it Electron dies silently on require()

#include <windows.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <d3d11_1.h>
#include <dxgi1_6.h>

#include <node_api.h>

// x64-only spike: an 8 byte NT handle is the whole premise of the OSR path (T03).
static_assert(sizeof(HANDLE) == 8, "Harbor spike addon requires x64 (HANDLE must be 8 bytes)");
static_assert(sizeof(void*) == 8, "Harbor spike addon requires x64");

namespace {

// Bumped by hand when the ABI of this module changes; T03 keeps the same string shape so
// evidence logs stay greppable.
constexpr const char* kBuildStamp = "harbor_spike/0.1.0-t01";

// Known constant for the load self-check. selfcheck.js recomputes this value from a seed
// it passes in and compares, so "the call worked" cannot be faked with a hardcoded string:
// a stub returning a fixed number fails the comparison for every seed but one.
constexpr uint32_t kSelftestSalt = 0x5A5A1234u;

constexpr size_t kSmallBuf = 64;
constexpr size_t kNameBuf = 256;

// ---------------------------------------------------------------------------
// napi helpers. All of them report failure by return value, never by throwing.
// ---------------------------------------------------------------------------

napi_value MakeString(napi_env env, const char* text) {
  napi_value out = nullptr;
  const char* src = (text != nullptr) ? text : "";
  if (napi_create_string_utf8(env, src, NAPI_AUTO_LENGTH, &out) != napi_ok) {
    return nullptr;
  }
  return out;
}

bool SetString(napi_env env, napi_value obj, const char* key, const char* value) {
  napi_value v = MakeString(env, value);
  if (v == nullptr) {
    return false;
  }
  return napi_set_named_property(env, obj, key, v) == napi_ok;
}

bool SetUint32(napi_env env, napi_value obj, const char* key, uint32_t value) {
  napi_value v = nullptr;
  if (napi_create_uint32(env, value, &v) != napi_ok) {
    return false;
  }
  return napi_set_named_property(env, obj, key, v) == napi_ok;
}

bool SetBool(napi_env env, napi_value obj, const char* key, bool value) {
  napi_value v = nullptr;
  if (napi_get_boolean(env, value, &v) != napi_ok) {
    return false;
  }
  return napi_set_named_property(env, obj, key, v) == napi_ok;
}

// Reads process.versions.<field> as UTF-8. An empty string means "not available"
// (e.g. "electron" is absent when the module is loaded by plain node) -- that is a
// legitimate answer, not an error, so the caller decides what it means.
void ReadProcessVersion(napi_env env, const char* field, char* out, size_t cap) {
  if (out == nullptr || cap == 0) {
    return;
  }
  out[0] = '\0';

  napi_value global = nullptr;
  napi_value process = nullptr;
  napi_value versions = nullptr;
  napi_value value = nullptr;
  napi_valuetype type = napi_undefined;

  if (napi_get_global(env, &global) != napi_ok || global == nullptr) {
    return;
  }
  if (napi_get_named_property(env, global, "process", &process) != napi_ok) {
    return;
  }
  if (napi_typeof(env, process, &type) != napi_ok || type != napi_object) {
    return;
  }
  if (napi_get_named_property(env, process, "versions", &versions) != napi_ok) {
    return;
  }
  if (napi_typeof(env, versions, &type) != napi_ok || type != napi_object) {
    return;
  }
  if (napi_get_named_property(env, versions, field, &value) != napi_ok) {
    return;
  }
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    return;
  }
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, out, cap, &written) != napi_ok) {
    out[0] = '\0';
  }
}

// ---------------------------------------------------------------------------
// GPU probe: the same readout the M1 probes confirmed is available in this session
// (D3D11CreateDevice hr=S_OK). Everything is released before returning, so the export
// is a pure read and safe to call repeatedly.
// ---------------------------------------------------------------------------

struct GpuInfo {
  bool d3dOk = false;
  uint32_t d3dHr = 0;
  uint32_t dxgiHr = 0;
  uint32_t featureLevel = 0;
  char adapterLuid[kSmallBuf] = "0-0";
  char adapterName[kNameBuf] = "";
};

GpuInfo ProbeGpu() {
  GpuInfo info;

  IDXGIFactory1* factory = nullptr;
  IDXGIAdapter1* adapter = nullptr;
  ID3D11Device* device = nullptr;
  ID3D11DeviceContext* context = nullptr;

  HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory));
  info.dxgiHr = static_cast<uint32_t>(hr);
  if (SUCCEEDED(hr) && factory != nullptr) {
    IDXGIAdapter1* first = nullptr;
    if (SUCCEEDED(factory->EnumAdapters1(0, &first)) && first != nullptr) {
      adapter = first;
      DXGI_ADAPTER_DESC1 desc;
      std::memset(&desc, 0, sizeof(desc));
      if (SUCCEEDED(adapter->GetDesc1(&desc))) {
        std::snprintf(info.adapterLuid, sizeof(info.adapterLuid), "%08lX-%08lX",
                      static_cast<unsigned long>(desc.AdapterLuid.HighPart),
                      static_cast<unsigned long>(desc.AdapterLuid.LowPart));
        // WideCharToMultiByte is the only safe way to turn the adapter name into UTF-8;
        // a plain printf of wchar_t would produce '?' on every non-ASCII character.
        if (WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, info.adapterName,
                                static_cast<int>(sizeof(info.adapterName)), nullptr,
                                nullptr) <= 0) {
          std::snprintf(info.adapterName, sizeof(info.adapterName), "%s", "<unnamed>");
        }
      }
    }
  }

  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
  const UINT levelCount = static_cast<UINT>(sizeof(levels) / sizeof(levels[0]));
  // D3D_FEATURE_LEVEL_0 exists only from the Win10 SDK onward and is NOT visible in every
  // toolchain configuration, so seed the out-param with a guaranteed-defined value; the
  // call overwrites it on success and we only read it when SUCCEEDED(hr).
  D3D_FEATURE_LEVEL got = D3D_FEATURE_LEVEL_11_0;

  // When an explicit adapter is passed the driver type MUST be UNKNOWN, otherwise
  // D3D11CreateDevice returns E_INVALIDARG.
  const D3D_DRIVER_TYPE driverType =
      (adapter != nullptr) ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE;

  hr = D3D11CreateDevice(adapter, driverType, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                         levels, levelCount, D3D11_SDK_VERSION, &device, &got, &context);
  info.d3dHr = static_cast<uint32_t>(hr);
  if (SUCCEEDED(hr)) {
    info.d3dOk = true;
    info.featureLevel = static_cast<uint32_t>(got);
  }

  if (context != nullptr) {
    context->Release();
  }
  if (device != nullptr) {
    device->Release();
  }
  if (adapter != nullptr) {
    adapter->Release();
  }
  if (factory != nullptr) {
    factory->Release();
  }
  return info;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// hostVersion(): non-empty string. Carries the runtime triple so a caller can tell
// "loaded by Electron" from "loaded by plain node" without any extra plumbing.
napi_value HostVersion(napi_env env, napi_callback_info /*info*/) {
  char electron[kSmallBuf] = "";
  char node[kSmallBuf] = "";
  ReadProcessVersion(env, "electron", electron, sizeof(electron));
  ReadProcessVersion(env, "node", node, sizeof(node));

  char buffer[256] = "";
  std::snprintf(buffer, sizeof(buffer), "%s napi=%d electron=%s node=%s", kBuildStamp,
                static_cast<int>(NAPI_VERSION), (electron[0] != '\0') ? electron : "none",
                (node[0] != '\0') ? node : "unknown");
  return MakeString(env, buffer);
}

// probeSelf(): the self-description T03 augments. Reads the real adapter LUID, which is
// the field that later has to match the LUID Electron's GPU process reports.
napi_value ProbeSelf(napi_env env, napi_callback_info /*info*/) {
  napi_value result = nullptr;
  if (napi_create_object(env, &result) != napi_ok || result == nullptr) {
    napi_throw_error(env, nullptr, "harbor_spike: cannot allocate probeSelf result");
    return nullptr;
  }

  char electron[kSmallBuf] = "";
  char node[kSmallBuf] = "";
  ReadProcessVersion(env, "electron", electron, sizeof(electron));
  ReadProcessVersion(env, "node", node, sizeof(node));

  const GpuInfo gpu = ProbeGpu();

  const bool ok = SetString(env, result, "buildStamp", kBuildStamp) &&
                  SetString(env, result, "electron", electron) &&
                  SetString(env, result, "node", node) &&
                  SetUint32(env, result, "napiVersion", static_cast<uint32_t>(NAPI_VERSION)) &&
                  SetBool(env, result, "d3dOk", gpu.d3dOk) &&
                  SetUint32(env, result, "d3dHr", gpu.d3dHr) &&
                  SetUint32(env, result, "dxgiHr", gpu.dxgiHr) &&
                  SetUint32(env, result, "featureLevel", gpu.featureLevel) &&
                  SetString(env, result, "adapterLuid", gpu.adapterLuid) &&
                  SetString(env, result, "dxgiAdapter", gpu.adapterName);
  if (!ok) {
    napi_throw_error(env, nullptr, "harbor_spike: cannot populate probeSelf result");
    return nullptr;
  }
  return result;
}

// selftestCalc(seed): proves the native code actually runs, not just that the symbol
// resolved. The result depends on the argument in a way that is cheap to recompute in
// JS, so a hardcoded return value cannot satisfy the caller.
//   result = (seed * 2654435761 + kSelftestSalt) ^ (seed >> 3)
napi_value SelfTestCalc(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) {
    napi_throw_error(env, nullptr, "harbor_spike: napi_get_cb_info failed");
    return nullptr;
  }
  if (argc < 1) {
    napi_throw_error(env, nullptr, "harbor_spike: selftestCalc expects one number");
    return nullptr;
  }

  double raw = 0.0;
  if (napi_get_value_double(env, argv[0], &raw) != napi_ok) {
    napi_throw_error(env, nullptr, "harbor_spike: selftestCalc seed is not a number");
    return nullptr;
  }
  // Truncate into a defined 32-bit domain; the JS side does the same before comparing.
  const uint32_t seed = static_cast<uint32_t>(static_cast<int64_t>(raw) & 0xFFFFFFFFll);
  const uint32_t mixed = (seed * 2654435761u + kSelftestSalt) ^ (seed >> 3);

  napi_value out = nullptr;
  if (napi_create_uint32(env, mixed, &out) != napi_ok) {
    napi_throw_error(env, nullptr, "harbor_spike: cannot create selftestCalc result");
    return nullptr;
  }
  return out;
}

// selftestSalt(): exposes the constant the mixer uses, so the JS check can recompute the
// expected value independently instead of trusting a number printed by the addon itself.
napi_value SelfTestSalt(napi_env env, napi_callback_info /*info*/) {
  napi_value out = nullptr;
  if (napi_create_uint32(env, kSelftestSalt, &out) != napi_ok) {
    napi_throw_error(env, nullptr, "harbor_spike: cannot create selftestSalt result");
    return nullptr;
  }
  return out;
}

napi_value Init(napi_env env, napi_value exports) {
  // napi_default_jsproperty, not napi_default: the bare default leaves the properties
  // non-enumerable, so Object.keys() on the loaded module comes back empty and any
  // exporter that lists members proves nothing. These exports are meant to be visible.
  napi_property_descriptor properties[] = {
      {"hostVersion", nullptr, HostVersion, nullptr, nullptr, nullptr,
       napi_default_jsproperty, nullptr},
      {"probeSelf", nullptr, ProbeSelf, nullptr, nullptr, nullptr,
       napi_default_jsproperty, nullptr},
      {"selftestCalc", nullptr, SelfTestCalc, nullptr, nullptr, nullptr,
       napi_default_jsproperty, nullptr},
      {"selftestSalt", nullptr, SelfTestSalt, nullptr, nullptr, nullptr,
       napi_default_jsproperty, nullptr},
  };
  const size_t count = sizeof(properties) / sizeof(properties[0]);
  if (napi_define_properties(env, exports, count, properties) != napi_ok) {
    napi_throw_error(env, nullptr, "harbor_spike: napi_define_properties failed");
    return nullptr;
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
