// dcomp_host.h —— 通路 A（双窗 + DirectComposition）主机接口
//
// M2 Spike 的可运行工作面。设计约束（全部来自实测，见 R101-M2 前置取证报告）：
//   1. Present1 的 SyncInterval 必须是 1，0 表示"立刻返回、不等 vsync"（节拍会掉到 0.15ms 级）。
//   2. 交换链必须同时满足三件事：SyncInterval=1 + FRAME_LATENCY_WAITABLE_OBJECT +
//      SetMaximumFrameLatency(1) + GetFrameLatencyWaitableObject；并且必须通过
//      IDCompositionVisual::SetContent 挂进 DComp 合成树并 Commit。
//   3. DPI 感知必须在进程最开头显式设置（否则 SM_CXSCREEN 返回逻辑尺寸 1707 而不是物理 2560）。
//
// 本机为真实桌面会话，建窗可行（原"沙箱下建窗必失败"的结论已被 winprobe.exe 实测推翻）。

#pragma once

#include <windows.h>

#include <cstdint>
#include <cstdio>
#include <vector>

#include <d3d11_1.h>
#include <dcomp.h>
#include <dxgi1_6.h>
#include <wrl/client.h>

namespace harbor {
namespace spike_a {

using Microsoft::WRL::ComPtr;

// 一条 HRESULT 记录。所有链路调用都必须进这个表，不许 (void) 吞掉。
struct HrRecord {
  const char* tag = "";
  HRESULT hr = S_OK;
};

// HRESULT 台账：按调用顺序记录，退出时统一打印，可被脚本 grep。
class HrLog {
 public:
  void Add(const char* tag, HRESULT hr) { items_.push_back(HrRecord{tag, hr}); }
  bool AllOk() const;
  size_t FailCount() const;
  // 逐行打印 `HR <tag>=0x00000000`，末尾打印 HR_ALL_OK / HR_FAIL_COUNT。
  void Report(FILE* out) const;
  const std::vector<HrRecord>& items() const { return items_; }

 private:
  std::vector<HrRecord> items_;
};

enum class DpiMode { kPerMonitorV2, kSystemFallback, kFailed };

const char* DpiModeName(DpiMode mode);

// 一个窗口的创建参数。clear_color 为 RGBA 顺序（D3D11 ClearRenderTargetView 口径）。
struct HostWindowSpec {
  const wchar_t* class_name = L"HarborSpikeAWin";
  const wchar_t* title = L"Harbor Spike A";
  int32_t x = 0;
  int32_t y = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  float clear_color[4] = {1.0f, 0.0f, 1.0f, 1.0f};
};

// 一个窗口的全套资源：HWND + 交换链 + waitable + DComp 视觉树 + 渲染目标。
struct WindowCtx {
  HostWindowSpec spec{};
  HWND hwnd = nullptr;
  uint32_t width = 0;
  uint32_t height = 0;
  ComPtr<IDXGISwapChain1> chain1;
  ComPtr<IDXGISwapChain2> chain2;
  ComPtr<ID3D11Texture2D> backbuffer;
  ComPtr<ID3D11RenderTargetView> rtv;
  ComPtr<IDCompositionTarget> target;
  ComPtr<IDCompositionVisual> visual;
  HANDLE frame_latency_waitable = nullptr;
  uint64_t presents = 0;
  uint64_t waits_ok = 0;
  uint64_t waits_timeout = 0;
};

// DComp 设备的两种建法，实测哪个能 CreateTargetForHwnd（见报告 §6）。
enum class DcompDeviceApi { kCreateDeviceFromDxgi, kCreateDevice2Null };

const char* DcompDeviceApiName(DcompDeviceApi api);

// 双窗（可扩展为 N 窗）DComp 主机。Init → AddWindow*N → 帧循环 → Shutdown。
class SpikeDCompHost {
 public:
  SpikeDCompHost() = default;
  ~SpikeDCompHost();
  SpikeDCompHost(const SpikeDCompHost&) = delete;
  SpikeDCompHost& operator=(const SpikeDCompHost&) = delete;

  // 🔴 必须最先调用（在 D3D11 设备与任何窗口之前）。
  // 先试 PER_MONITOR_AWARE_V2，失败回退 SetProcessDPIAware()，两者都失败返回 kFailed。
  static DpiMode InitDpi(HrLog* log);
  // 当前进程线程的 DPI 感知名字（用于自证断言）。
  static const char* CurrentDpiAwarenessName();

  // 建设备：D3D11（BGRA，FL 11_1 → 11_0 回退）+ IDXGIFactory2 + DComp 设备。
  bool Init(HINSTANCE hinst, bool hdr_fp16, DcompDeviceApi api, HrLog* log);

  // 建一个完整窗口链路。spec 的 x/y/w/h 为物理像素（调用方已保证 DPI aware）。
  bool AddWindow(const HostWindowSpec& spec, HrLog* log);

  // 全部资源集中释放，幂等。~SpikeDCompHost() 只调它（唯一释放路径）。
  void Shutdown();

  size_t WindowCount() const { return windows_.size(); }
  WindowCtx& Window(size_t i) { return windows_[i]; }
  const WindowCtx& Window(size_t i) const { return windows_[i]; }

  ID3D11Device* Device() const { return d3d_.Get(); }
  ID3D11DeviceContext* Ctx() const { return ctx_.Get(); }
  IDXGIFactory2* Factory() const { return factory_.Get(); }
  IDCompositionDevice* Dcomp() const { return dcomp_.Get(); }
  D3D_FEATURE_LEVEL feature_level() const { return feature_level_; }
  const wchar_t* adapter_name() const { return adapter_name_; }
  LUID adapter_luid() const { return adapter_luid_; }
  DcompDeviceApi dcomp_api() const { return dcomp_api_; }

  // NC-A2 负控开关：为 true 时跳过 dc->Commit()（合成树不生效，窗口上不会有内容）。
  void SetSkipCommit(bool skip) { skip_commit_ = skip; }
  bool skip_commit() const { return skip_commit_; }
  // NC-A2 下被跳过的 Commit 次数（用于在报告里区分"没有 Commit 调用"与"Commit 失败"）。
  uint32_t commit_skips() const { return commit_skips_; }

  // 清屏到 rgba（RGBA 顺序）。
  void ClearWindow(size_t i, const float rgba[4]);
  // Present1 单窗。sync_interval 必须是 1 才有 vsync 节拍。
  HRESULT PresentWindow(size_t i, int sync_interval);
  // 等该窗的 frameLatencyWaitable。
  DWORD WaitWindow(size_t i, DWORD timeout_ms);

 private:
  bool BuildDcompDevice(HrLog* log);
  bool BuildSwapChain(size_t i, HrLog* log);
  bool BuildVisualTree(size_t i, HrLog* log);

  ComPtr<ID3D11Device> d3d_;
  ComPtr<ID3D11DeviceContext> ctx_;
  ComPtr<IDXGIFactory2> factory_;
  ComPtr<IDCompositionDevice> dcomp_;

  HINSTANCE hinst_ = nullptr;
  bool hdr_fp16_ = false;
  bool skip_commit_ = false;
  uint32_t commit_skips_ = 0;
  bool shutdown_done_ = false;
  DcompDeviceApi dcomp_api_ = DcompDeviceApi::kCreateDeviceFromDxgi;
  D3D_FEATURE_LEVEL feature_level_ = D3D_FEATURE_LEVEL_11_0;
  wchar_t adapter_name_[128] = L"";
  LUID adapter_luid_ = {0, 0};

  std::vector<WindowCtx> windows_;
  std::vector<const wchar_t*> registered_classes_;
};

// ---- 像素上屏自证（DDA）----------------------------------------------------

// 期望色按 DDA 的 BGRA 字节序存放，B/G/R/A 直接与 Map 出来的 4 字节对齐比较。
struct Bgra8 {
  uint8_t b = 0;
  uint8_t g = 0;
  uint8_t r = 0;
  uint8_t a = 0;
};

// 把 RGBA 浮点清屏色转成 DDA 读到的 BGRA 期望值。
Bgra8 BgraFromClearColor(const float rgba[4]);

struct VerifyOptions {
  // NC-A3：把读取坐标乘 1.5，模拟 DPI UNAWARE 下的错误换算。必须让自证变红。
  bool offset_15x = false;
  uint32_t tolerance = 8;          // 逐通道容差
  uint32_t max_attempts = 90;      // 抓帧尝试次数上限
  uint32_t acquire_timeout_ms = 60;
  uint32_t min_frames = 1;         // 至少抓到这么多帧且全窗通过才算过
};

struct VerifyWindowResult {
  size_t index = 0;
  RECT rect = {0, 0, 0, 0};
  int32_t coord_x = 0;
  int32_t coord_y = 0;
  bool in_rect = false;
  bool color_hit = false;
  Bgra8 expect{};
  Bgra8 got{};
  uint64_t frames_seen = 0;   // 该窗口被成功读到的次数
  bool pass() const { return in_rect && color_hit; }
  // OK / COORD_OUT_OF_RECT / COLOR_MISMATCH —— 座标判据优先，便于区分负控原因。
  const char* FailReason() const;
};

struct VerifyResult {
  bool dda_available = false;
  HRESULT dup_hr = E_FAIL;
  HRESULT acquire_last_hr = E_FAIL;
  uint32_t surface_width = 0;
  uint32_t surface_height = 0;
  uint32_t frames_acquired = 0;
  uint32_t attempts_used = 0;
  bool timed_out = false;
  std::vector<VerifyWindowResult> windows;
  bool pass_all() const;
  // 全窗都通过时返回空串，否则返回首个失败原因（含窗口序号）。
  const char* FailReason() const;
};

// 抓 1 帧桌面，读每个窗口中心像素。两条判据（颜色命中 + 坐标在窗内）必须同时成立。
// 注意：DDA 只在桌面图像变化时交付帧，故本函数内部会让窗口在 base/base+1 间抖动以强制
// DWM 重合成，结束后把窗口位置还原到 base。
bool VerifyOnScreen(SpikeDCompHost* host, const VerifyOptions& opt, VerifyResult* out,
                    HrLog* log);

}  // namespace spike_a
}  // namespace harbor