// dcomp_host.cpp —— M2 通路 A 主机。本机为真实桌面会话（E1 实测建窗成功），
// 原「沙箱/无桌面会话下建窗必然静默失败」的结论已作废；像素上屏自证见 VerifyOnScreen()。
//
// 完整链路（每个 HRESULT 都进 HrLog，不许 (void) 吞掉）：
//   DPI 感知 → D3D11 设备 → IDXGIFactory2 → DComp 设备 → 每窗:
//   CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP) → CreateSwapChainForComposition
//   → SetMaximumFrameLatency(1) → GetFrameLatencyWaitableObject
//   → CreateTargetForHwnd → CreateVisual → SetContent → SetRoot → Commit → DwmSetWindowAttribute
//
// 实测要点（R101-M2 前置取证报告 §0）：
//   * Present1 的 SyncInterval=1 才能被 vsync 钉住；=0 时 waitable 瞬间放行，间隔 0.15ms 级。
//   * 交换链三件事缺一不可（SyncInterval=1 / WAITABLE + maxLatency 1 / 挂进 DComp 树并 Commit）。
//   * DPI 感知必须显式设置：UNAWARE 下 SM_CXSCREEN 返回逻辑尺寸 1707，物理是 2560×1440。

#include "dcomp_host.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>

#include <dwmapi.h>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "dcomp.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

// SDK 头里没有时补上常量（Win11 圆角）。
#ifndef DWMWA_WINDOW_CORNER_PREFERENCE
#define DWMWA_WINDOW_CORNER_PREFERENCE 33
#endif
#ifndef DWMWCP_ROUND
#define DWMWCP_ROUND 2
#endif

namespace harbor {
namespace spike_a {
namespace {

// 逐通道容差比较，两个都按 BGRA 字节序。
bool ColorWithin(const Bgra8& got, const Bgra8& expect, uint32_t tolerance) {
  const int db = std::abs(static_cast<int>(got.b) - static_cast<int>(expect.b));
  const int dg = std::abs(static_cast<int>(got.g) - static_cast<int>(expect.g));
  const int dr = std::abs(static_cast<int>(got.r) - static_cast<int>(expect.r));
  const int da = std::abs(static_cast<int>(got.a) - static_cast<int>(expect.a));
  const int t = static_cast<int>(tolerance);
  return db <= t && dg <= t && dr <= t && da <= t;
}

uint8_t FloatToUnorm8(float v) {
  if (v <= 0.0f) return 0;
  if (v >= 1.0f) return 255;
  return static_cast<uint8_t>(v * 255.0f + 0.5f);
}

LRESULT CALLBACK DefaultWndProc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
  return DefWindowProcW(hwnd, msg, wparam, lparam);
}

// 释放顺序按 §E-7：视觉树/目标 → 交换链 → waitable → RTV/backbuffer。
void ReleaseWindow(WindowCtx* w) {
  if (!w) return;
  if (w->target) { w->target.Reset(); }
  if (w->visual) { w->visual.Reset(); }
  if (w->chain2) { w->chain2.Reset(); }
  if (w->chain1) { w->chain1.Reset(); }
  if (w->rtv) { w->rtv.Reset(); }
  if (w->backbuffer) { w->backbuffer.Reset(); }
  // waitable 是 HANDLE，ComPtr 管不了，必须显式关闭；放在交换链彻底释放之后。
  if (w->frame_latency_waitable) {
    CloseHandle(w->frame_latency_waitable);
    w->frame_latency_waitable = nullptr;
  }
  if (w->hwnd) {
    DestroyWindow(w->hwnd);
    w->hwnd = nullptr;
  }
}

}  // namespace

// ============================================================================
// HrLog
// ============================================================================

bool HrLog::AllOk() const { return FailCount() == 0; }

size_t HrLog::FailCount() const {
  size_t n = 0;
  for (const HrRecord& r : items_) {
    if (FAILED(r.hr)) ++n;
  }
  return n;
}

void HrLog::Report(FILE* out) const {
  if (!out) return;
  for (const HrRecord& r : items_) {
    fprintf(out, "HR %-38s=0x%08lX\n", r.tag, static_cast<unsigned long>(r.hr));
  }
  fprintf(out, "HR_FAIL_COUNT=%zu\n", FailCount());
  fprintf(out, "HR_ALL_OK=%d\n", AllOk() ? 1 : 0);
  fflush(out);
}

const char* DpiModeName(DpiMode mode) {
  switch (mode) {
    case DpiMode::kPerMonitorV2: return "PER_MONITOR_AWARE_V2";
    case DpiMode::kSystemFallback: return "SYSTEM_AWARE_FALLBACK";
    case DpiMode::kFailed: return "DPI_INIT_FAILED";
  }
  return "UNKNOWN";
}

const char* DcompDeviceApiName(DcompDeviceApi api) {
  switch (api) {
    case DcompDeviceApi::kCreateDeviceFromDxgi: return "DCompositionCreateDevice(dxgiDevice)";
    case DcompDeviceApi::kCreateDevice2Null: return "DCompositionCreateDevice2(nullptr)";
  }
  return "UNKNOWN";
}

// ============================================================================
// DPI
// ============================================================================

DpiMode SpikeDCompHost::InitDpi(HrLog* log) {
  // 必须在任何窗口/设备创建之前。失败不许静默继续。
  SetLastError(0);
  if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
    if (log) log->Add("SetProcessDpiAwarenessContext(PMv2)", S_OK);
    return DpiMode::kPerMonitorV2;
  }
  const DWORD err = GetLastError();
  const HRESULT hr_ctx = HRESULT_FROM_WIN32(err ? err : ERROR_INVALID_FUNCTION);
  if (log) log->Add("SetProcessDpiAwarenessContext(PMv2)", hr_ctx);

  // 回退：Vista 时代的 system-DPI-aware。仍失败就显式报错。
  SetLastError(0);
  if (SetProcessDPIAware()) {
    if (log) log->Add("SetProcessDPIAware(fallback)", S_OK);
    return DpiMode::kSystemFallback;
  }
  const DWORD err2 = GetLastError();
  if (log) log->Add("SetProcessDPIAware(fallback)", HRESULT_FROM_WIN32(err2 ? err2 : ERROR_INVALID_FUNCTION));
  return DpiMode::kFailed;
}

const char* SpikeDCompHost::CurrentDpiAwarenessName() {
  DPI_AWARENESS_CONTEXT ctx = GetThreadDpiAwarenessContext();
  if (AreDpiAwarenessContextsEqual(ctx, DPI_AWARENESS_CONTEXT_UNAWARE)) return "UNAWARE";
  if (AreDpiAwarenessContextsEqual(ctx, DPI_AWARENESS_CONTEXT_SYSTEM_AWARE)) return "SYSTEM_AWARE";
  if (AreDpiAwarenessContextsEqual(ctx, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE)) {
    return "PER_MONITOR_AWARE";
  }
  if (AreDpiAwarenessContextsEqual(ctx, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
    return "PER_MONITOR_AWARE_V2";
  }
  if (AreDpiAwarenessContextsEqual(ctx, DPI_AWARENESS_CONTEXT_UNAWARE_GDISCALED)) {
    return "UNAWARE_GDISCALED";
  }
  return "OTHER";
}

// ============================================================================
// 生命周期
// ============================================================================

SpikeDCompHost::~SpikeDCompHost() { Shutdown(); }

void SpikeDCompHost::Shutdown() {
  if (shutdown_done_) return;
  shutdown_done_ = true;

  // S1–S6：依赖倒序。视觉树先死，再交换链，最后设备。
  for (WindowCtx& w : windows_) ReleaseWindow(&w);
  windows_.clear();

  dcomp_.Reset();
  factory_.Reset();
  ctx_.Reset();
  d3d_.Reset();
}

// ============================================================================
// Init
// ============================================================================

bool SpikeDCompHost::Init(HINSTANCE hinst, bool hdr_fp16, DcompDeviceApi api, HrLog* log) {
  hinst_ = hinst;
  hdr_fp16_ = hdr_fp16;
  dcomp_api_ = api;
  shutdown_done_ = false;

  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  // FL 11_1 在老运行库上会返回 E_INVALIDARG，此时必须去掉 11_1 重试（不是失败）。
  D3D_FEATURE_LEVEL levels_11_1[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
  D3D_FEATURE_LEVEL levels_11_0[] = {D3D_FEATURE_LEVEL_11_0};

  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, levels_11_1,
                                _countof(levels_11_1), D3D11_SDK_VERSION, d3d_.GetAddressOf(),
                                &feature_level_, ctx_.GetAddressOf());
  if (log) log->Add("D3D11CreateDevice(FL11_1)", hr);
  if (hr == E_INVALIDARG) {
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, levels_11_0,
                           _countof(levels_11_0), D3D11_SDK_VERSION, d3d_.GetAddressOf(),
                           &feature_level_, ctx_.GetAddressOf());
    if (log) log->Add("D3D11CreateDevice(FL11_0)", hr);
  }
  if (FAILED(hr)) return false;

  // 拿 IDXGIDevice → adapter → IDXGIFactory2（CreateSwapChainForComposition 的出处）。
  ComPtr<IDXGIDevice> dxgi_device;
  hr = d3d_.As(&dxgi_device);
  if (log) log->Add("ID3D11Device.As(IDXGIDevice)", hr);
  if (FAILED(hr)) return false;

  ComPtr<IDXGIAdapter> adapter;
  hr = dxgi_device->GetAdapter(adapter.GetAddressOf());
  if (log) log->Add("IDXGIDevice.GetAdapter", hr);
  if (FAILED(hr)) return false;

  DXGI_ADAPTER_DESC ad = {};
  if (SUCCEEDED(adapter->GetDesc(&ad))) {
    wcsncpy_s(adapter_name_, _countof(adapter_name_), ad.Description, _TRUNCATE);
    adapter_luid_ = ad.AdapterLuid;
  }
  hr = adapter->GetParent(IID_PPV_ARGS(factory_.GetAddressOf()));
  if (log) log->Add("IDXGIAdapter.GetParent(IDXGIFactory2)", hr);
  if (FAILED(hr)) return false;

  return BuildDcompDevice(log);
}

bool SpikeDCompHost::BuildDcompDevice(HrLog* log) {
  ComPtr<IDXGIDevice> dxgi_device;
  HRESULT hr = d3d_.As(&dxgi_device);
  if (FAILED(hr)) {
    if (log) log->Add("BuildDcompDevice.As(IDXGIDevice)", hr);
    return false;
  }

  if (dcomp_api_ == DcompDeviceApi::kCreateDeviceFromDxgi) {
    // 首选：与 DXGI 设备关联。CreateTargetForHwnd 需要这层关联。
    hr = DCompositionCreateDevice(dxgi_device.Get(), IID_PPV_ARGS(dcomp_.GetAddressOf()));
    if (log) log->Add("DCompositionCreateDevice(dxgiDevice)", hr);
  } else {
    hr = DCompositionCreateDevice2(nullptr, IID_PPV_ARGS(dcomp_.GetAddressOf()));
    if (log) log->Add("DCompositionCreateDevice2(nullptr)", hr);
  }
  return SUCCEEDED(hr);
}

// ============================================================================
// 建窗 + 交换链 + 视觉树
// ============================================================================

bool SpikeDCompHost::AddWindow(const HostWindowSpec& spec, HrLog* log) {
  if (!hinst_) hinst_ = GetModuleHandleW(nullptr);

  // 类名只注册一次（双窗可能共用类）。
  bool already = false;
  for (const wchar_t* name : registered_classes_) {
    if (wcscmp(name, spec.class_name) == 0) { already = true; break; }
  }
  if (!already) {
    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(wc);
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = DefaultWndProc;
    wc.hInstance = hinst_;
    wc.hCursor = LoadCursorW(nullptr, reinterpret_cast<LPCWSTR>(IDC_ARROW));
    wc.hbrBackground = nullptr;  // 无重定向表面，背景必须留空
    wc.lpszClassName = spec.class_name;
    ATOM atom = RegisterClassExW(&wc);
    HRESULT hr = atom ? S_OK : HRESULT_FROM_WIN32(GetLastError());
    if (log) log->Add("RegisterClassExW", hr);
    if (!atom) return false;
    registered_classes_.push_back(spec.class_name);
  }

  WindowCtx w = {};
  w.spec = spec;
  w.width = spec.width;
  w.height = spec.height;

  // WS_EX_NOREDIRECTIONBITMAP = 没有 DWM 重定向表面，由 DComp 直接合成。
  // WS_EX_NOACTIVATE = 背板窗不抢焦点。WS_EX_TOPMOST = 保证自证时不被遮挡（DDA 只读上屏像素）。
  // WS_POPUP + 显式宽高 = 客户区尺寸 == 交换链尺寸（无边框误差）。
  w.hwnd = CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
                           spec.class_name, spec.title, WS_POPUP, spec.x, spec.y,
                           static_cast<int>(spec.width), static_cast<int>(spec.height), nullptr,
                           nullptr, hinst_, nullptr);
  HRESULT hr_win = w.hwnd ? S_OK : HRESULT_FROM_WIN32(GetLastError());
  if (log) log->Add("CreateWindowExW(NOREDIRECTIONBITMAP)", hr_win);
  if (!w.hwnd) return false;

  ShowWindow(w.hwnd, SW_SHOWNOACTIVATE);

  // 圆角：不支持的平台会返回错误，容许失败但要记录（不许静默）。
  int corner = DWMWCP_ROUND;
  HRESULT hr_corner = DwmSetWindowAttribute(w.hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &corner,
                                            sizeof(corner));
  if (log) log->Add("DwmSetWindowAttribute(CORNER=ROUND)", hr_corner);

  windows_.push_back(w);
  const size_t idx = windows_.size() - 1;

  if (!BuildSwapChain(idx, log)) {
    ReleaseWindow(&windows_[idx]);
    windows_.pop_back();
    return false;
  }
  if (!BuildVisualTree(idx, log)) {
    ReleaseWindow(&windows_[idx]);
    windows_.pop_back();
    return false;
  }
  return true;
}

bool SpikeDCompHost::BuildSwapChain(size_t i, HrLog* log) {
  WindowCtx& w = windows_[i];
  if (!factory_ || !d3d_ || !w.hwnd) return false;

  DXGI_SWAP_CHAIN_DESC1 desc = {};
  desc.Width = w.width;
  desc.Height = w.height;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.Stereo = FALSE;
  desc.SampleDesc.Count = 1;
  desc.SampleDesc.Quality = 0;
  desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  desc.BufferCount = 2;
  desc.Scaling = DXGI_SCALING_STRETCH;
  desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
  desc.AlphaMode = DXGI_ALPHA_MODE_PREMULTIPLIED;  // DComp 内容必须预乘
  desc.Flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;

  HRESULT hr = factory_->CreateSwapChainForComposition(d3d_.Get(), &desc, nullptr,
                                                       w.chain1.GetAddressOf());
  if (log) log->Add("CreateSwapChainForComposition", hr);
  if (FAILED(hr)) return false;

  hr = w.chain1.As(&w.chain2);
  if (log) log->Add("IDXGISwapChain1.As(IDXGISwapChain2)", hr);
  if (FAILED(hr)) return false;

  // 节拍三件事之二：maxLatency=1 + waitable 句柄。
  hr = w.chain2->SetMaximumFrameLatency(1);
  if (log) log->Add("SetMaximumFrameLatency(1)", hr);
  if (FAILED(hr)) return false;

  w.frame_latency_waitable = w.chain2->GetFrameLatencyWaitableObject();
  HRESULT hr_wait = w.frame_latency_waitable ? S_OK : E_HANDLE;
  if (log) log->Add("GetFrameLatencyWaitableObject", hr_wait);
  if (!w.frame_latency_waitable) return false;

  hr = w.chain2->GetBuffer(0, IID_PPV_ARGS(w.backbuffer.GetAddressOf()));
  if (log) log->Add("IDXGISwapChain2.GetBuffer(0)", hr);
  if (FAILED(hr)) return false;

  hr = d3d_->CreateRenderTargetView(w.backbuffer.Get(), nullptr, w.rtv.GetAddressOf());
  if (log) log->Add("CreateRenderTargetView", hr);
  return SUCCEEDED(hr);
}

bool SpikeDCompHost::BuildVisualTree(size_t i, HrLog* log) {
  WindowCtx& w = windows_[i];
  if (!dcomp_ || !w.hwnd || !w.chain1) return false;

  HRESULT hr = dcomp_->CreateTargetForHwnd(w.hwnd, TRUE, w.target.GetAddressOf());
  if (log) log->Add("CreateTargetForHwnd(topmost=TRUE)", hr);
  if (FAILED(hr)) return false;

  hr = dcomp_->CreateVisual(w.visual.GetAddressOf());
  if (log) log->Add("CreateVisual", hr);
  if (FAILED(hr)) return false;

  // DComp 只认 IDXGISwapChain（for composition）；SetContent 接受 IUnknown*。
  hr = w.visual->SetContent(w.chain1.Get());
  if (log) log->Add("IDCompositionVisual.SetContent(swapChain)", hr);
  if (FAILED(hr)) return false;

  hr = w.target->SetRoot(w.visual.Get());
  if (log) log->Add("IDCompositionTarget.SetRoot(visual)", hr);
  if (FAILED(hr)) return false;

  // 节拍三件事之三：Commit（NC-A2 会显式跳过这一步，届时所有 HRESULT 仍为 0 但不上屏）。
  // 跳过时**不往 HR 台账里塞假失败** —— NC-A2 的论点正是「HRESULT 全 0 也不证明上屏」，
  // 若这里记一条 E_PENDING，台账本身就被污染成"有一条红的"，反而看不出论证要点。
  if (skip_commit_) {
    ++commit_skips_;
    return true;
  }
  hr = dcomp_->Commit();
  if (log) log->Add("IDCompositionDevice.Commit", hr);
  return SUCCEEDED(hr);
}

// ============================================================================
// 渲染
// ============================================================================

void SpikeDCompHost::ClearWindow(size_t i, const float rgba[4]) {
  if (i >= windows_.size()) return;
  WindowCtx& w = windows_[i];
  if (!ctx_ || !w.rtv) return;
  ctx_->ClearRenderTargetView(w.rtv.Get(), rgba);
}

HRESULT SpikeDCompHost::PresentWindow(size_t i, int sync_interval) {
  if (i >= windows_.size()) return E_INVALIDARG;
  WindowCtx& w = windows_[i];
  if (!w.chain2) return E_UNEXPECTED;
  DXGI_PRESENT_PARAMETERS params = {};
  HRESULT hr = w.chain2->Present1(static_cast<UINT>(sync_interval), 0, &params);
  if (SUCCEEDED(hr)) ++w.presents;
  return hr;
}

DWORD SpikeDCompHost::WaitWindow(size_t i, DWORD timeout_ms) {
  if (i >= windows_.size()) return WAIT_FAILED;
  WindowCtx& w = windows_[i];
  if (!w.frame_latency_waitable) return WAIT_FAILED;
  // bAlertable=TRUE：允许 APC 唤醒，与 calib.cpp 的口径一致。
  DWORD rc = WaitForSingleObjectEx(w.frame_latency_waitable, timeout_ms, TRUE);
  if (rc == WAIT_OBJECT_0) ++w.waits_ok;
  else if (rc == WAIT_TIMEOUT) ++w.waits_timeout;
  return rc;
}

// ============================================================================
// 像素上屏自证
// ============================================================================

Bgra8 BgraFromClearColor(const float rgba[4]) {
  // ClearRenderTargetView 取 RGBA 顺序；DDA 读到的 B8G8R8A8 内存序是 B,G,R,A。
  Bgra8 c;
  c.b = FloatToUnorm8(rgba[2]);
  c.g = FloatToUnorm8(rgba[1]);
  c.r = FloatToUnorm8(rgba[0]);
  c.a = FloatToUnorm8(rgba[3]);
  return c;
}

const char* VerifyWindowResult::FailReason() const {
  if (!in_rect) return "COORD_OUT_OF_RECT";
  if (!color_hit) return "COLOR_MISMATCH";
  return "OK";
}

bool VerifyResult::pass_all() const {
  if (!dda_available) return false;
  if (frames_acquired < 1) return false;
  if (windows.empty()) return false;
  for (const VerifyWindowResult& w : windows) {
    if (!w.pass()) return false;
  }
  return true;
}

const char* VerifyResult::FailReason() const {
  if (!dda_available) return "DDA_UNAVAILABLE";
  if (frames_acquired < 1) return "NO_FRAME_CAPTURED";
  if (windows.empty()) return "NO_WINDOW";
  for (const VerifyWindowResult& w : windows) {
    if (!w.pass()) return w.FailReason();
  }
  return "OK";
}

bool VerifyOnScreen(SpikeDCompHost* host, const VerifyOptions& opt, VerifyResult* out, HrLog* log) {
  if (!out) return false;
  *out = VerifyResult{};
  if (!host || host->WindowCount() == 0) return false;

  ID3D11Device* device = host->Device();
  ID3D11DeviceContext* ctx = host->Ctx();
  if (!device || !ctx) return false;

  // 1) 找挂着桌面的 output，建 duplication。
  ComPtr<IDXGIAdapter> adapter;
  ComPtr<IDXGIDevice> dxgi_device;
  if (FAILED(device->QueryInterface(IID_PPV_ARGS(dxgi_device.GetAddressOf())))) return false;
  if (FAILED(dxgi_device->GetAdapter(adapter.GetAddressOf()))) return false;

  ComPtr<IDXGIFactory1> factory1;
  if (FAILED(adapter->GetParent(IID_PPV_ARGS(factory1.GetAddressOf())))) return false;

  ComPtr<IDXGIOutput1> output1;
  for (UINT ai = 0; !output1; ++ai) {
    ComPtr<IDXGIAdapter1> a1;
    if (factory1->EnumAdapters1(ai, a1.GetAddressOf()) != S_OK) break;
    for (UINT oi = 0; !output1; ++oi) {
      ComPtr<IDXGIOutput> o;
      if (a1->EnumOutputs(oi, o.GetAddressOf()) != S_OK) break;
      DXGI_OUTPUT_DESC od = {};
      if (SUCCEEDED(o->GetDesc(&od)) && od.AttachedToDesktop) {
        o.As(&output1);
      }
    }
    a1.Reset();
  }
  if (!output1) {
    if (log) log->Add("EnumOutputs(attached)", DXGI_ERROR_NOT_FOUND);
    return false;
  }

  ComPtr<IDXGIOutputDuplication> dup;
  out->dup_hr = output1->DuplicateOutput(device, dup.GetAddressOf());
  if (log) log->Add("IDXGIOutput1.DuplicateOutput", out->dup_hr);
  if (FAILED(out->dup_hr)) return false;

  DXGI_OUTDUPL_DESC dd = {};
  dup->GetDesc(&dd);
  out->surface_width = dd.ModeDesc.Width;
  out->surface_height = dd.ModeDesc.Height;
  out->dda_available = (dd.ModeDesc.Width > 0 && dd.ModeDesc.Height > 0);

  // 2) 每个窗口预先算好期望色、基准矩形与读取坐标。
  struct Target {
    size_t index = 0;
    RECT base_rect = {0, 0, 0, 0};
    int32_t base_x = 0;
    int32_t base_y = 0;
    Bgra8 expect{};
  };
  std::vector<Target> targets;
  out->windows.clear();
  for (size_t i = 0; i < host->WindowCount(); ++i) {
    const WindowCtx& wc = host->Window(i);
    Target t;
    t.index = i;
    GetWindowRect(wc.hwnd, &t.base_rect);
    t.base_x = t.base_rect.left;
    t.base_y = t.base_rect.top;
    t.expect = BgraFromClearColor(wc.spec.clear_color);
    targets.push_back(t);

    VerifyWindowResult vr;
    vr.index = i;
    vr.rect = t.base_rect;
    vr.expect = t.expect;
    const int32_t cx = (t.base_rect.left + t.base_rect.right) / 2;
    const int32_t cy = (t.base_rect.top + t.base_rect.bottom) / 2;
    if (opt.offset_15x) {
      // NC-A3：模拟 DPI UNAWARE 下的错误换算（把已物理的坐标再乘 1.5）。
      vr.coord_x = static_cast<int32_t>(std::lround(cx * 1.5));
      vr.coord_y = static_cast<int32_t>(std::lround(cy * 1.5));
    } else {
      vr.coord_x = cx;
      vr.coord_y = cy;
    }
    out->windows.push_back(vr);
  }

  // 3) staging 纹理（首次知道 surface 尺寸后才能建）。
  ComPtr<ID3D11Texture2D> staging;

  bool all_pass = false;
  for (uint32_t attempt = 0; attempt < opt.max_attempts && !all_pass; ++attempt) {
    out->attempts_used = attempt + 1;

    // 抖动 1px 并重绘：DDA 只在桌面图像变化时交付帧，静止画面会一直 WAIT_TIMEOUT。
    const int dx = static_cast<int>(attempt % 2);
    for (const Target& t : targets) {
      SetWindowPos(host->Window(t.index).hwnd, HWND_TOPMOST, t.base_x + dx, t.base_y + dx, 0, 0,
                   SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
      host->ClearWindow(t.index, host->Window(t.index).spec.clear_color);
      host->PresentWindow(t.index, 1);
      host->WaitWindow(t.index, 200);
    }

    DXGI_OUTDUPL_FRAME_INFO frame_info = {};
    ComPtr<IDXGIResource> resource;
    out->acquire_last_hr = dup->AcquireNextFrame(opt.acquire_timeout_ms, &frame_info,
                                                 resource.GetAddressOf());
    if (out->acquire_last_hr == DXGI_ERROR_WAIT_TIMEOUT) {
      out->timed_out = true;
      continue;
    }
    if (FAILED(out->acquire_last_hr)) break;

    ComPtr<ID3D11Texture2D> tex;
    if (FAILED(resource.As(&tex))) {
      dup->ReleaseFrame();
      continue;
    }

    D3D11_TEXTURE2D_DESC td = {};
    tex->GetDesc(&td);
    out->surface_width = td.Width;
    out->surface_height = td.Height;

    if (!staging) {
      D3D11_TEXTURE2D_DESC sd = td;
      sd.Usage = D3D11_USAGE_STAGING;
      sd.BindFlags = 0;
      sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
      sd.MiscFlags = 0;
      sd.ArraySize = 1;
      sd.MipLevels = 1;
      HRESULT hr_st = device->CreateTexture2D(&sd, nullptr, staging.GetAddressOf());
      if (log) log->Add("CreateTexture2D(DDA staging)", hr_st);
      if (FAILED(hr_st)) {
        dup->ReleaseFrame();
        break;
      }
    }

    ctx->CopyResource(staging.Get(), tex.Get());
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    HRESULT hr_map = ctx->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped);
    if (SUCCEEDED(hr_map)) {
      ++out->frames_acquired;
      const BYTE* base = static_cast<const BYTE*>(mapped.pData);
      for (VerifyWindowResult& vr : out->windows) {
        const bool in_surface = vr.coord_x >= 0 && vr.coord_y >= 0 &&
                                vr.coord_x < static_cast<int32_t>(td.Width) &&
                                vr.coord_y < static_cast<int32_t>(td.Height);
        vr.in_rect = vr.coord_x >= vr.rect.left && vr.coord_x < vr.rect.right &&
                     vr.coord_y >= vr.rect.top && vr.coord_y < vr.rect.bottom;
        if (in_surface) {
          const BYTE* p = base + static_cast<size_t>(vr.coord_y) * mapped.RowPitch +
                          static_cast<size_t>(vr.coord_x) * 4;
          vr.got.b = p[0];
          vr.got.g = p[1];
          vr.got.r = p[2];
          vr.got.a = p[3];
        } else {
          vr.got = Bgra8{0, 0, 0, 0};
        }
        vr.color_hit = ColorWithin(vr.got, vr.expect, opt.tolerance);
        if (vr.pass()) ++vr.frames_seen;
      }
      ctx->Unmap(staging.Get(), 0);
    } else if (log) {
      log->Add("Map(DDA staging)", hr_map);
    }

    resource.Reset();
    dup->ReleaseFrame();

    all_pass = out->pass_all() && out->frames_acquired >= opt.min_frames;
  }

  // 4) 还原窗口位置（抖动残留必须清掉）。
  for (const Target& t : targets) {
    SetWindowPos(host->Window(t.index).hwnd, HWND_TOPMOST, t.base_x, t.base_y, 0, 0,
                 SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    host->ClearWindow(t.index, host->Window(t.index).spec.clear_color);
    host->PresentWindow(t.index, 1);
    host->WaitWindow(t.index, 200);
  }

  return out->pass_all();
}

}  // namespace spike_a
}  // namespace harbor