// d1_indep_probe2.cpp -- D1「层间独立性」可行性探针 v2（真双线程）
//
// ## v1 为什么作废（必须记下来，这是本探针的核心教训）
//
// v1（d1_indep_probe.cpp）是**单线程串行**：Present(0) → Sleep → Wait(0) → Present(1) → Wait(1)。
// 它测出 T2 = WIN1_DRAGGED（窗1 间隔从 6.05 涨到 16.0ms），我差点据此判「两链耦合」。
// 但那个 drag 是**探针自己串行结构造成的**：
//   Sleep(12) 发生在窗1 的 Present 之前，窗1 当然被推后 12ms。
// 这与 dcomp_demo 的错误完全同构 —— **仪器与被测对象同构，测到的是仪器不是对象**（教训 #18）。
// v1 唯一可信的是 T3 = INJECTION_EFFECTIVE（正样本：注入造出 42ms vs 6.05ms 间隔）。
//
// ## v2 的设计（修掉同构问题）
//
// 每窗一个独立线程，各自循环 Clear/Present/Wait，**线程之间零同步**（无屏障、无互斥）。
// 共享的只有：t0（启动前取一次）、注入调度表（只读）、输出缓冲（各写各的 slot）。
// 这样「窗0 卡住时窗1 是否照常」才是真的独立性测度。
//
// ## 判据（必须能分辨「独立」与「耦合」）
//
// 主判据 `win1GapP50UnderWin0Stall`：
//   - 若两链**独立**：窗0 Sleep(12ms) 期间，窗1 线程照常每 6.06ms Present 一次
//     → 窗1 的间隔分布**不受影响**（P50 ≈ 6.06ms）
//   - 若两链**耦合**：窗1 被拖住 → 窗1 的间隔 P50 显著 > 6.06ms
//
// 关键：这个判据只有在**真双线程**下才有意义。单线程下它恒为「耦合」。
//
// 副判据 `stallFrameCountWin0` / `stallFrameCountWin1`：
//   - 窗0 注入 N 次 stall → 窗0 应有 N 个长间隔
//   - 窗1 若独立 → 窗1 的长间隔数应 ≈ 自然掉拍数（远小于 N）
//   - 窗1 若耦合 → 窗1 的长间隔数 ≈ N
//
// ## 输出
// 全部 KEY=VALUE。另外把逐帧原始数据落 JSONL（每窗一行），供事后用任何口径验算。
//
// 构建：见 bd1indep2.bat
// 用法：d1_indep_probe2.exe [--seconds=10] [--stall-every=200ms] [--stall-ms=12]

#include <windows.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <d3d11_1.h>
#include <dcomp.h>
#include <dxgi1_6.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

namespace {

LARGE_INTEGER g_freq;

// 注：早期版本曾尝试 --shared-ctx（两窗共用一个 device）作为耦合负控，
// 但共享立即上下文在双线程下直接 0xC0000005（COM 引用计数与并发双重问题）。
// 已改为 --serial 模式（单线程内串行跑两窗），它更贴近 dcomp_demo 现状，
// 也是判据"应红"的天然对照。两条路径都已实测，见 d1v2-*.txt。

double NowMs() {
  LARGE_INTEGER t;
  QueryPerformanceCounter(&t);
  return static_cast<double>(t.QuadPart) * 1000.0 / static_cast<double>(g_freq.QuadPart);
}

uint64_t NowUs() {
  LARGE_INTEGER t;
  QueryPerformanceCounter(&t);
  return static_cast<uint64_t>(t.QuadPart) * 1000000ULL /
         static_cast<uint64_t>(g_freq.QuadPart);
}

// 一窗的运行时资源与自身统计（每线程独占写，无需锁）
struct WinSlot {
  HWND hwnd = nullptr;
  // 🔴 每窗【独立 D3D11 device + 立即上下文】。
  // D3D11 的 ID3D11DeviceContext 不是线程安全的：两个线程同时调
  // ClearRenderTargetView 会直接 0xC0000005（本探针 v2 首版实测崩溃，
  // EXIT_CODE=-1073741819）。每窗独立 device 是唯一无需全局锁的解法，
  // 且更贴近真实形态（每个窗口一个渲染设备）。
  ComPtr<ID3D11Device> dev;
  ComPtr<ID3D11DeviceContext> ctx;
  ComPtr<IDXGIFactory2> factory;
  ComPtr<IDXGISwapChain2> chain2;
  ComPtr<ID3D11RenderTargetView> rtv;
  ComPtr<IDCompositionTarget> target;
  ComPtr<IDCompositionVisual> visual;
  HANDLE waitable = nullptr;

  // 本窗的逐帧样本（线程独占写）
  struct Sample {
    uint64_t qpcUs;
    double submitUs;
    double waitUs;
    int waitRc;      // 0=OK 1=TIMEOUT 2=FAILED
    int presentOk;
    int injected;    // 本次迭代是否注入了 stall
  };
  std::vector<Sample> samples;

  uint64_t presents = 0;
  uint64_t waitTimeouts = 0;
  int injectedCount = 0;
};

struct Host {
  ComPtr<IDCompositionDevice> dcomp;
  WinSlot slots[2];
  LPCWSTR cls[2] = {L"D1v2Win0", L"D1v2Win1"};
  bool shutdownDone = false;

  ~Host() { Shutdown(); }

  static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_DESTROY) return 0;
    return DefWindowProcW(h, m, w, l);
  }

  // 为一窗建独立 device + factory。每窗一套，避免立即上下文跨线程竞态。
  static bool MakeDevice(WinSlot& s) {
    D3D_FEATURE_LEVEL lv[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    D3D_FEATURE_LEVEL got = D3D_FEATURE_LEVEL_11_0;
    HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                   D3D11_CREATE_DEVICE_BGRA_SUPPORT, lv, 2,
                                   D3D11_SDK_VERSION, &s.dev, &got, &s.ctx);
    if (FAILED(hr)) return false;
    ComPtr<IDXGIDevice> dg;
    if (FAILED(s.dev.As(&dg))) return false;
    ComPtr<IDXGIAdapter> ad;
    if (FAILED(dg->GetAdapter(&ad))) return false;
    ComPtr<IDXGIFactory1> f1;
    if (FAILED(ad->GetParent(IID_PPV_ARGS(&f1)))) return false;
    return SUCCEEDED(f1.As(&s.factory));
  }

  bool Init() {
    // DComp 设备只需一个（合成树是进程级资源，且 Commit 由主线程调用）。
    if (!MakeDevice(slots[0])) { printf("INIT_DEVICE0=FAIL\n"); return false; }
    ComPtr<IDXGIDevice> dg;
    if (FAILED(slots[0].dev.As(&dg))) return false;
    ComPtr<IDCompositionDevice> dc;
    HRESULT hr = DCompositionCreateDevice(dg.Get(), __uuidof(IDCompositionDevice),
                                 reinterpret_cast<void**>(dc.GetAddressOf()));
    if (FAILED(hr)) { printf("HR_DCOMPDEVICE=0x%08lX\n", (unsigned long)hr); return false; }
    dcomp = dc;
    return true;
  }

  bool AddWin(int idx, int x, int y, int w, int h, float r, float g, float b) {
    WinSlot& s = slots[idx];
    // 窗 0 的 device 已在 Init() 建好；窗 1 在此处新建自己的。
    // 🔴 每窗独立 device/context 是硬要求：共享会让双线程并发调立即上下文崩溃。
    if (!s.dev) {
      if (!MakeDevice(s)) {
        printf("INIT_DEVICE_%d=FAIL\n", idx);
        return false;
      }
    }
    HINSTANCE hi = GetModuleHandleW(nullptr);
    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(wc);
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = &Host::WndProc;
    wc.hInstance = hi;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.lpszClassName = cls[idx];
    if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
      printf("HR_REGISTERCLASS_%d=0x%08lX\n", idx, (unsigned long)GetLastError());
      return false;
    }
    s.hwnd = CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
                             cls[idx], L"d1v2", WS_POPUP, x, y, w, h, nullptr, nullptr, hi,
                             nullptr);
    if (!s.hwnd) {
      printf("HR_CREATEWINDOW_%d=0x%08lX\n", idx, (unsigned long)GetLastError());
      return false;
    }
    ShowWindow(s.hwnd, SW_SHOWNOACTIVATE);

    DXGI_SWAP_CHAIN_DESC1 sd = {};
    sd.Width = static_cast<UINT>(w);
    sd.Height = static_cast<UINT>(h);
    sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    sd.SampleDesc.Count = 1;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.BufferCount = 2;
    sd.Scaling = DXGI_SCALING_STRETCH;
    sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
    sd.AlphaMode = DXGI_ALPHA_MODE_PREMULTIPLIED;
    // 🔴 必须带此 flag，否则 SetMaximumFrameLatency -> DXGI_ERROR_INVALID_CALL (0x887A0001)
    sd.Flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;

    ComPtr<IDXGISwapChain1> c1;
    HRESULT hr = s.factory->CreateSwapChainForComposition(s.dev.Get(), &sd, nullptr, &c1);
    if (FAILED(hr)) { printf("HR_CREATESWAPCHAIN_%d=0x%08lX\n", idx, (unsigned long)hr); return false; }
    if (FAILED(c1.As(&s.chain2))) return false;

    hr = s.chain2->SetMaximumFrameLatency(1);
    if (FAILED(hr)) { printf("HR_SETMAXLAT_%d=0x%08lX\n", idx, (unsigned long)hr); return false; }
    s.waitable = s.chain2->GetFrameLatencyWaitableObject();
    if (!s.waitable) { printf("HR_GETWAITABLE_%d=FAIL\n", idx); return false; }

    ComPtr<ID3D11Texture2D> bb;
    if (FAILED(s.chain2->GetBuffer(0, __uuidof(ID3D11Texture2D),
                                   reinterpret_cast<void**>(bb.GetAddressOf())))) return false;
    if (FAILED(s.dev->CreateRenderTargetView(bb.Get(), nullptr, &s.rtv))) return false;

    hr = dcomp->CreateTargetForHwnd(s.hwnd, TRUE, &s.target);
    if (FAILED(hr)) { printf("HR_CREATETARGET_%d=0x%08lX\n", idx, (unsigned long)hr); return false; }
    hr = dcomp->CreateVisual(&s.visual);
    if (FAILED(hr)) { printf("HR_CREATEVISUAL_%d=0x%08lX\n", idx, (unsigned long)hr); return false; }
    hr = s.visual->SetContent(c1.Get());
    if (FAILED(hr)) { printf("HR_SETCONTENT_%d=0x%08lX\n", idx, (unsigned long)hr); return false; }
    hr = s.target->SetRoot(s.visual.Get());
    if (FAILED(hr)) { printf("HR_SETROOT_%d=0x%08lX\n", idx, (unsigned long)hr); return false; }
    hr = dcomp->Commit();
    if (FAILED(hr)) { printf("HR_COMMIT_%d=0x%08lX\n", idx, (unsigned long)hr); return false; }

    const float col[4] = {r, g, b, 1.0f};
    s.ctx->ClearRenderTargetView(s.rtv.Get(), col);
    DXGI_PRESENT_PARAMETERS pp = {};
    s.chain2->Present1(1, 0, &pp);
    ++s.presents;
    WaitForSingleObjectEx(s.waitable, 500, TRUE);
    return true;
  }

  void Shutdown() {
    if (shutdownDone) return;
    shutdownDone = true;
    if (dcomp) dcomp->Commit();
    for (auto& s : slots) {
      if (s.visual) s.visual.Reset();
      if (s.target) s.target.Reset();
      if (s.rtv) s.rtv.Reset();
      if (s.chain2) s.chain2.Reset();
      if (s.waitable) { CloseHandle(s.waitable); s.waitable = nullptr; }
      if (s.factory) s.factory.Reset();
      if (s.ctx) s.ctx.Reset();
      if (s.dev) s.dev.Reset();
      if (s.hwnd) { DestroyWindow(s.hwnd); s.hwnd = nullptr; }
    }
    if (dcomp) dcomp.Reset();
  }
};

double Percentile(std::vector<double> v, double p) {
  if (v.empty()) return 0.0;
  std::sort(v.begin(), v.end());
  const double idx = p * static_cast<double>(v.size() - 1);
  const size_t lo = static_cast<size_t>(idx);
  const size_t hi = (lo + 1 < v.size()) ? lo + 1 : lo;
  return v[lo] * (1.0 - (idx - static_cast<double>(lo))) +
         v[hi] * (idx - static_cast<double>(lo));
}

struct RunCfg {
  double seconds = 10.0;
  double stallEveryMs = 200.0;  // 每多少毫秒注入一次
  int stallMs = 12;             // 注入时长
  int injectWin = 0;            // 注入哪个窗（0 / 1 / -1=都不注入）
  // 🔴 --serial：串行负控（应判 COUPLED）。单线程内先窗0 再窗1，完全复刻
  //    dcomp_demo 现状的 for(i) 结构。这是判据的「应红」对照：
  //    若此模式仍报 INDEPENDENT，说明判据恒真、失效（教训 #1）。
  bool serial = false;
  bool dumpJsonl = false;
  const char* jsonlPath = nullptr;
};

// 🔴 耦合负控：--shared-ctx 的开关与锁已在文件前部声明（Host::AddWin 需要读它）。
// 这里不再重复声明。

// 单窗线程主循环。**线程内零同步**，只读 cfg 与 t0StartUs。
void WindowThread(Host* host, int idx, const RunCfg* cfg, uint64_t t0StartUs,
                  std::atomic<bool>* stop, FILE* jsonlSame) {
  WinSlot& s = host->slots[idx];
  const float col[4] = {(idx == 0) ? 1.0f : 0.0f, (idx == 0) ? 0.0f : 1.0f, 1.0f, 1.0f};

  double nextInjectAt = NowMs() + cfg->stallEveryMs;
  s.samples.reserve(20000);

  for (;;) {
    if (stop->load(std::memory_order_relaxed)) break;
    const double loopStart = NowMs();

    // —— submit 段：清屏 + Present1（只算本窗自己的 CPU 耗时）
    const double t0 = NowMs();
    s.ctx->ClearRenderTargetView(s.rtv.Get(), col);
    DXGI_PRESENT_PARAMETERS pp = {};
    const HRESULT hrPresent = s.chain2->Present1(1, 0, &pp);
    const double submitUs = (NowMs() - t0) * 1000.0;
    const int presentOk = SUCCEEDED(hrPresent) ? 1 : 0;
    if (presentOk) ++s.presents;

    // —— 注入段：只在本窗注入，且不持有任何锁
    int injected = 0;
    if (cfg->injectWin == idx && cfg->stallMs > 0) {
      const double now = NowMs();
      if (now >= nextInjectAt) {
        injected = 1;
        ++s.injectedCount;
        Sleep(static_cast<DWORD>(cfg->stallMs));
        nextInjectAt = now + cfg->stallEveryMs;
      }
    }

    // —— wait 段：等本窗自己的 waitable
    const double w0 = NowMs();
    const DWORD rc = WaitForSingleObjectEx(s.waitable, 250, TRUE);
    const double waitUs = (NowMs() - w0) * 1000.0;
    if (rc == WAIT_TIMEOUT) ++s.waitTimeouts;

    const uint64_t qpcUs = NowUs();

    WinSlot::Sample smp;
    smp.qpcUs = qpcUs;
    smp.submitUs = submitUs;
    smp.waitUs = waitUs;
    smp.waitRc = (rc == WAIT_OBJECT_0 || rc == WAIT_ABANDONED) ? 0 : (rc == WAIT_TIMEOUT ? 1 : 2);
    smp.presentOk = presentOk;
    smp.injected = injected;
    s.samples.push_back(smp);

    if (jsonlSame) {
      fprintf(jsonlSame,
              "{\"win\":%d,\"qpcUs\":%llu,\"relUs\":%lld,\"submitUs\":%.1f,"
              "\"waitUs\":%.1f,\"waitRc\":%d,\"presentOk\":%d,\"injected\":%d}\n",
              idx, static_cast<unsigned long long>(qpcUs),
              static_cast<long long>(qpcUs - t0StartUs), submitUs, waitUs, smp.waitRc,
              presentOk, injected);
      fflush(jsonlSame);
    }

    (void)loopStart;
  }
}

// 从样本序列算「间隔」序列（相邻 qpcUs 差，单位 ms）
std::vector<double> GapsMs(const WinSlot& s, std::vector<char>* injectedFlags) {
  std::vector<double> g;
  if (s.samples.size() < 2) return g;
  g.reserve(s.samples.size() - 1);
  if (injectedFlags) injectedFlags->reserve(s.samples.size() - 1);
  for (size_t i = 1; i < s.samples.size(); ++i) {
    const double d = static_cast<double>(s.samples[i].qpcUs - s.samples[i - 1].qpcUs) / 1000.0;
    g.push_back(d);
    if (injectedFlags) injectedFlags->push_back(static_cast<char>(s.samples[i].injected));
  }
  return g;
}

}  // namespace

int main(int argc, char** argv) {
  SetConsoleOutputCP(CP_UTF8);
  QueryPerformanceFrequency(&g_freq);

  RunCfg cfg;
  for (int i = 1; i < argc; ++i) {
    if (std::strncmp(argv[i], "--seconds=", 10) == 0) cfg.seconds = std::atof(argv[i] + 10);
    else if (std::strncmp(argv[i], "--stall-every=", 14) == 0) cfg.stallEveryMs = std::atof(argv[i] + 14);
    else if (std::strncmp(argv[i], "--stall-ms=", 11) == 0) cfg.stallMs = std::atoi(argv[i] + 11);
    else if (std::strncmp(argv[i], "--inject-win=", 13) == 0) cfg.injectWin = std::atoi(argv[i] + 13);
    else if (std::strncmp(argv[i], "--jsonl=", 8) == 0) { cfg.dumpJsonl = true; cfg.jsonlPath = argv[i] + 8; }
    else if (std::strcmp(argv[i], "--serial") == 0) cfg.serial = true;
  }

  printf("PROBE=d1_indep_probe2 MODE=%s\n", cfg.serial ? "SERIAL_NEGCONTROL" : "THREADED");
  printf("SECONDS=%.2f STALL_EVERY_MS=%.1f STALL_MS=%d INJECT_WIN=%d\n", cfg.seconds,
         cfg.stallEveryMs, cfg.stallMs, cfg.injectWin);
  printf("QPC_FREQ=%lld\n", static_cast<long long>(g_freq.QuadPart));

  Host host;
  if (!host.Init()) { printf("INIT=FAIL\n"); return 2; }

  // 两窗【完全重叠】：D1 的真实形态（层间），不是并列。
  if (!host.AddWin(0, 500, 400, 400, 300, 1.0f, 0.0f, 1.0f)) { printf("ADDWIN0=FAIL\n"); return 3; }
  if (!host.AddWin(1, 500, 400, 400, 300, 0.0f, 1.0f, 1.0f)) { printf("ADDWIN1=FAIL\n"); return 4; }
  printf("WINDOWS=2 OVERLAP=1 RECT=(500,400) 400x300\n");

  FILE* jsonl = nullptr;
  if (cfg.dumpJsonl && cfg.jsonlPath && *cfg.jsonlPath) {
    if (fopen_s(&jsonl, cfg.jsonlPath, "wb") != 0) { printf("JSONL_OPEN=FAIL\n"); jsonl = nullptr; }
    else printf("JSONL_OPEN=OK path=%s\n", cfg.jsonlPath);
  }
  fflush(stdout);

  // 🔴 t0 必须在两线程启动【之前】取一次，之后只读。
  //    若各线程各取 t0，两窗的 idx 会有固定偏移 -> 永远不同帧 -> ratio 恒 1（假数据）。
  const uint64_t t0StartUs = NowUs();

  std::atomic<bool> stop{false};
  std::thread t0;
  std::thread t1;

  if (cfg.serial) {
    // 🔴 串行负控：单线程内先窗0 再窗1，完全复刻 dcomp_demo 现状的 for(i) 结构。
    // 这是「应判 COUPLED」的天然正对照 —— 因为单线程串行下，窗0 的 stall 必然
    // 把窗1 推后（Sleep 发生在窗1 Present 之前）。
    // 若判据在此模式仍报 INDEPENDENT，说明判据失效（教训 #1）。
    t0 = std::thread([&] {
      WinSlot& a = host.slots[0];
      WinSlot& b = host.slots[1];
      const float ca[4] = {1.0f, 0.0f, 1.0f, 1.0f};
      const float cb[4] = {0.0f, 1.0f, 1.0f, 1.0f};
      double nextInj = NowMs() + cfg.stallEveryMs;
      a.samples.reserve(20000);
      b.samples.reserve(20000);
      for (;;) {
        if (stop.load(std::memory_order_relaxed)) break;
        int injected = 0;
        // —— 窗0：Clear → Present → (注入) → Wait
        {
          const double t = NowMs();
          a.ctx->ClearRenderTargetView(a.rtv.Get(), ca);
          DXGI_PRESENT_PARAMETERS pp = {};
          const HRESULT hr = a.chain2->Present1(1, 0, &pp);
          const double subUs = (NowMs() - t) * 1000.0;
          if (SUCCEEDED(hr)) ++a.presents;
          if (cfg.injectWin == 0 && cfg.stallMs > 0) {
            const double now = NowMs();
            if (now >= nextInj) { injected = 1; ++a.injectedCount; Sleep((DWORD)cfg.stallMs); nextInj = now + cfg.stallEveryMs; }
          }
          const double w0 = NowMs();
          const DWORD rc = WaitForSingleObjectEx(a.waitable, 250, TRUE);
          const double waitUs = (NowMs() - w0) * 1000.0;
          if (rc == WAIT_TIMEOUT) ++a.waitTimeouts;
          WinSlot::Sample smp;
          smp.qpcUs = NowUs(); smp.submitUs = subUs; smp.waitUs = waitUs;
          smp.waitRc = (rc == WAIT_OBJECT_0 || rc == WAIT_ABANDONED) ? 0 : (rc == WAIT_TIMEOUT ? 1 : 2);
          smp.presentOk = SUCCEEDED(hr) ? 1 : 0; smp.injected = injected;
          a.samples.push_back(smp);
          if (jsonl) { fprintf(jsonl, "{\"win\":0,\"qpcUs\":%llu,\"relUs\":%lld,\"submitUs\":%.1f,\"waitUs\":%.1f,\"waitRc\":%d,\"presentOk\":%d,\"injected\":%d}\n", (unsigned long long)smp.qpcUs, (long long)(smp.qpcUs - t0StartUs), subUs, waitUs, smp.waitRc, smp.presentOk, injected); fflush(jsonl); }
        }
        // —— 窗1：同结构，紧跟窗0（这就是串行耦合的来源）
        {
          const double t = NowMs();
          b.ctx->ClearRenderTargetView(b.rtv.Get(), cb);
          DXGI_PRESENT_PARAMETERS pp = {};
          const HRESULT hr = b.chain2->Present1(1, 0, &pp);
          const double subUs = (NowMs() - t) * 1000.0;
          if (SUCCEEDED(hr)) ++b.presents;
          int inj1 = 0;
          if (cfg.injectWin == 1 && cfg.stallMs > 0) {
            const double now = NowMs();
            if (now >= nextInj) { inj1 = 1; ++b.injectedCount; Sleep((DWORD)cfg.stallMs); nextInj = now + cfg.stallEveryMs; }
          }
          const double w0 = NowMs();
          const DWORD rc = WaitForSingleObjectEx(b.waitable, 250, TRUE);
          const double waitUs = (NowMs() - w0) * 1000.0;
          if (rc == WAIT_TIMEOUT) ++b.waitTimeouts;
          WinSlot::Sample smp;
          smp.qpcUs = NowUs(); smp.submitUs = subUs; smp.waitUs = waitUs;
          smp.waitRc = (rc == WAIT_OBJECT_0 || rc == WAIT_ABANDONED) ? 0 : (rc == WAIT_TIMEOUT ? 1 : 2);
          smp.presentOk = SUCCEEDED(hr) ? 1 : 0; smp.injected = inj1;
          b.samples.push_back(smp);
          if (jsonl) { fprintf(jsonl, "{\"win\":1,\"qpcUs\":%llu,\"relUs\":%lld,\"submitUs\":%.1f,\"waitUs\":%.1f,\"waitRc\":%d,\"presentOk\":%d,\"injected\":%d}\n", (unsigned long long)smp.qpcUs, (long long)(smp.qpcUs - t0StartUs), subUs, waitUs, smp.waitRc, smp.presentOk, inj1); fflush(jsonl); }
        }
        // 🔴 缺陷修正（本轮）：上一版这里写 `(void)injected;` 把窗0 的注入标志丢弃了，
        //    而上面 L419-431 明明算出了 injected=1。后果：串行模式下
        //    INJ_WIN_UNDER_STALL_N 恒为 0 -> INJECTION_VERDICT=INJECTION_UNDEFINED，
        //    即「应红」负控永远无法自证「注入生效」，判据链缺一环
        //    （53=53 的巧合极不可能，但"极不可能"不是判据）。
        //    标志已在上面的 smp.injected 里落地，这里不再需要 injected 变量。
      }
    });
  } else {
    t0 = std::thread([&] { WindowThread(&host, 0, &cfg, t0StartUs, &stop, jsonl); });
    t1 = std::thread([&] { WindowThread(&host, 1, &cfg, t0StartUs, &stop, jsonl); });
  }

  const DWORD runMs = static_cast<DWORD>(cfg.seconds * 1000.0);
  Sleep(runMs);
  stop.store(true, std::memory_order_relaxed);
  if (t0.joinable()) t0.join();
  if (t1.joinable()) t1.join();

  if (jsonl) { fclose(jsonl); jsonl = nullptr; }

  // ---------------- 分析 ----------------
  struct PerWin {
    size_t n = 0;
    double gapP50 = 0, gapP95 = 0, gapP99 = 0, gapMax = 0;
    double submitP50 = 0, waitP50 = 0;
    int drops = 0;       // 间隔 >= 1.5 * median
    int longGaps = 0;    // 间隔 >= 1.5 * median（同上，命名分开便于读）
    double dropRate = 0;
    int injected = 0;
    std::vector<double> gaps;
    std::vector<char> injFlags;
  } pw[2];

  double globalMedian = 0.0;
  {
    std::vector<double> all;
    for (int i = 0; i < 2; ++i) {
      auto g = GapsMs(host.slots[i], nullptr);
      all.insert(all.end(), g.begin(), g.end());
    }
    if (!all.empty()) {
      std::sort(all.begin(), all.end());
      globalMedian = all[all.size() / 2];
    }
  }
  printf("GLOBAL_GAP_MEDIAN_MS=%.4f\n", globalMedian);
  const double dropThresholdMs = globalMedian * 1.5;
  printf("DROP_THRESHOLD_MS=%.4f (1.5x median)\n", dropThresholdMs);

  for (int i = 0; i < 2; ++i) {
    auto g = GapsMs(host.slots[i], &pw[i].injFlags);
    pw[i].gaps = g;
    pw[i].n = host.slots[i].samples.size();
    pw[i].injected = host.slots[i].injectedCount;
    pw[i].gapP50 = Percentile(g, 0.50);
    pw[i].gapP95 = Percentile(g, 0.95);
    pw[i].gapP99 = Percentile(g, 0.99);
    pw[i].gapMax = g.empty() ? 0.0 : *std::max_element(g.begin(), g.end());
    std::vector<double> sub, wat;
    for (auto& smp : host.slots[i].samples) { sub.push_back(smp.submitUs); wat.push_back(smp.waitUs); }
    pw[i].submitP50 = Percentile(sub, 0.50);
    pw[i].waitP50 = Percentile(wat, 0.50);
    for (double v : g) if (v >= dropThresholdMs) ++pw[i].drops;
    pw[i].longGaps = pw[i].drops;
    pw[i].dropRate = g.empty() ? 0.0 : static_cast<double>(pw[i].drops) / static_cast<double>(g.size());

    printf("WIN%d_N=%zu WIN%d_INJECTED=%d\n", i, pw[i].n, i, pw[i].injected);
    printf("WIN%d_GAP_P50=%.4f WIN%d_GAP_P95=%.4f WIN%d_GAP_P99=%.4f WIN%d_GAP_MAX=%.4f\n",
           i, pw[i].gapP50, i, pw[i].gapP95, i, pw[i].gapP99, i, pw[i].gapMax);
    printf("WIN%d_SUBMIT_P50=%.1f WIN%d_WAIT_P50=%.1f\n", i, pw[i].submitP50, i, pw[i].waitP50);
    printf("WIN%d_DROPS=%d WIN%d_DROP_RATE=%.6f\n", i, pw[i].drops, i, pw[i].dropRate);
  }

  // ---- 核心判据：注入窗 stall 时，另一窗是否受影响 ----
  const int other = (cfg.injectWin == 0) ? 1 : 0;
  std::vector<double> otherGapsClean, otherGapsUnderStall;
  {
    // 按时间对齐：注入窗有 injected=1 的样本，其「前一个间隔」被拖长。
    // 对另一窗，取「同一时间窗内」的间隔。用 qpcUs 相对 t0 做时间对齐。
    const auto& injSamples = host.slots[cfg.injectWin].samples;
    std::vector<uint64_t> injWindows;  // 每次注入的 (startUs, endUs)
    for (size_t k = 0; k < injSamples.size(); ++k) {
      if (!injSamples[k].injected) continue;
      const uint64_t startUs = injSamples[k].qpcUs;
      const uint64_t endUs = startUs + static_cast<uint64_t>(cfg.stallMs) * 1000ULL;
      injWindows.push_back(startUs);
      injWindows.push_back(endUs);
    }
    auto inAnyInjWindow = [&](uint64_t us) {
      for (size_t k = 0; k + 1 < injWindows.size(); k += 2) {
        // 注入开始前 1 个 vsync 到结束后 1 个 vsync 之间算「受影响窗口」
        const uint64_t a = (injWindows[k] > 6060) ? injWindows[k] - 6060 : 0;
        const uint64_t b = injWindows[k + 1] + 6060;
        if (us >= a && us <= b) return true;
      }
      return false;
    };
    const auto& oSamples = host.slots[other].samples;
    for (size_t k = 1; k < oSamples.size(); ++k) {
      const double gap = static_cast<double>(oSamples[k].qpcUs - oSamples[k - 1].qpcUs) / 1000.0;
      if (inAnyInjWindow(oSamples[k].qpcUs)) otherGapsUnderStall.push_back(gap);
      else otherGapsClean.push_back(gap);
    }
    printf("\n--- 核心判据：窗%d 注入 stall 时，窗%d 是否被拖住 ---\n", cfg.injectWin, other);
    printf("OTHER_CLEAN_N=%zu OTHER_CLEAN_P50=%.4f OTHER_CLEAN_P95=%.4f\n",
           otherGapsClean.size(), Percentile(otherGapsClean, 0.50),
           Percentile(otherGapsClean, 0.95));
    printf("OTHER_STALL_N=%zu OTHER_STALL_P50=%.4f OTHER_STALL_P95=%.4f\n",
           otherGapsUnderStall.size(), Percentile(otherGapsUnderStall, 0.50),
           Percentile(otherGapsUnderStall, 0.95));
    // 🔴 空集必须显式报无效，不能拿 Percentile(空)=0 去比。
    // 这是教训 #1 的经典形态：串行负控下 OTHER_STALL_N=0，
    // 而空集 P50=0 -> DELTA=-6.06 -> 判 INDEPENDENT（假通过）。
    const bool isEmptySet = otherGapsUnderStall.empty() || otherGapsClean.empty();
    // OTHER_P50_DELTA_MS 降为**纯描述量**（架构师 v2.4 §14.3）：旧判据 `>3.0` 已作废，
    // 该量在 7/7 轮上恒为 -0.001~0.006ms。保留它只为报告需要，**不得作门**。
    const double d = isEmptySet
                         ? 0.0
                         : Percentile(otherGapsUnderStall, 0.50) -
                               Percentile(otherGapsClean, 0.50);
    printf("OTHER_P50_DELTA_MS=%.4f DESCRIPTIVE_ONLY=1 (旧判据 >3.0 已作废：占空比 8% "
           "⇒ P50 按定义不响应)\n", d);
    if (isEmptySet) {
      printf("OTHER_WINDOW_ALIGNMENT=EMPTY_SET (时间窗口对不上，本判据不可用)\n");
    }

    // 🔴 主判据改为【掉拍计数比对】——这是最本质、最不易被时间对齐搞错的量。
    //   串行（耦合）：注入窗的 stall 必然把另一窗也推长 -> 两窗掉拍数相等
    //   独立：只有注入窗掉拍，另一窗掉拍数 = 自然掉拍（应远小于注入数）
    const int injDrops = pw[cfg.injectWin].drops;
    const int otherDrops = pw[other].drops;
    const int injCount = pw[cfg.injectWin].injected;
    printf("DROP_COUNT_INJ_WIN=%d DROP_COUNT_OTHER_WIN=%d INJECT_COUNT=%d\n", injDrops, otherDrops,
           injCount);

    // ================= DEFECT-3 修正：零分母不再是"通过" =================
    // 事故：`injectCount=0` 时旧代码用
    //     const bool coupledByDrops = (injCount > 0) && (...);
    //     verdict = coupledByDrops ? "COUPLED" : "INDEPENDENT";
    // 守卫只挡住了「判耦合」，却让「判不耦合」照常输出 —— **空集被当成 0 参与了判决**。
    // 4/4 份全错（`t04_NC3_zero.txt` 8s + `t04_AN_r1/r2/r3.txt` 60s），
    // 全部报 `INDEP_VERDICT=INDEPENDENT` —— 方向恰好是"通过"，所以没人会去查它。
    //
    // 同一族还有第二处：`INJ_WIN_DROP ∈ [0.8, 1.5] × injectCount` 在 `injectCount=0`
    // 时退化成 `[0, 0]`，区间**退化了却仍然成立**，于是任何取值都"通过"。
    // 区间退化不是"更严格"，是"无定义"。
    //
    // 规矩：**分母为 0 的量一律输出 `null` + 显式状态，绝不输出数字，也绝不落到某个 verdict。**
    // 这与 `d1_r_probe.cpp` 里 `smp.injected = 0` 硬编码是同一族问题：
    // 缺证据被当成证据成立。
    const bool zeroDenominator = (injCount == 0);
    printf("DIVIDE_GUARD=%s\n", zeroDenominator ? "ZERO_DENOMINATOR" : "OK");
    if (zeroDenominator) {
      // coupleRatio = otherDrops / injCount，分母 0 ⇒ 无定义。**不写 0、不写 inf。**
      printf("COUPLE_RATIO=null COUPLE_RATIO_DENOM=0 COUPLE_RATIO_STATUS=UNMEASURABLE\n");
      // 掉拍窗比值区间 [0.8,1.5]×0 = [0,0]：退化区间必须判 INVALID，
      // 否则 `injDrops >= 0 && injDrops <= 0` 会把 0 掉拍判成"符合预期"。
      printf("INJ_WIN_DROP_RATIO_CHECK=INVALID "
             "(injCount=0 => 允许区间退化为 [0,0]，任何取值都会\"通过\"，故判无定义)\n");
    } else {
      const double coupleRatio = static_cast<double>(otherDrops) / static_cast<double>(injCount);
      printf("COUPLE_RATIO=%.6f COUPLE_RATIO_DENOM=%d COUPLE_RATIO_STATUS=MEASURED\n", coupleRatio,
             injCount);
      const double dropRatio = static_cast<double>(injDrops) / static_cast<double>(injCount);
      const bool dropRatioOk = (dropRatio >= 0.8) && (dropRatio <= 1.5);
      printf("INJ_WIN_DROP_RATIO_CHECK=%s injDropRatio=%.6f band=[0.8,1.5]\n",
             dropRatioOk ? "PASS" : "FAIL", dropRatio);
    }

    // ================= DEFECT-4 修正：补回 0.05 中间带 =================
    // 事故：架构文档 AC2 要求 coupleRatio ∈ [0.000, 0.050] 才判 INDEPENDENT，
    // §2.4 状态转移表第 3 行要求 [0.050, 0.500] 判「中间带 ⇒ UNMEASURABLE / blocked」。
    // 但旧代码只有一条边界 `otherDrops*2 >= injCount`（= coupleRatio >= 0.5），
    // **0.05 上界在代码里没有任何分支承接** ⇒ 0.050~0.500 整段被静默判成 INDEPENDENT。
    // 活体：`t04v2_AI_r1/r2/r3` 实测 coupleRatio = 0.349367 / 0.446701 / 0.316456，
    //       按文档都该是 UNMEASURABLE，旧代码全报 INDEPENDENT。
    // 这是教训 #34「规则写在注释里、不写进代码分支 = 没写」的又一实例：
    // 「0.000~0.050 才算 INDEPENDENT」这句要求，实际只能靠"数据恰好落在那儿"满足。
    //
    // 现在改为三带，边界值由常量驱动（INDEP_BAND_LO / INDEP_BAND_HI），
    // 与 §2.4 状态转移表逐字对齐，避免再次漂移。
    const double INDEP_BAND_LO = 0.050;  // < LO ⇒ INDEPENDENT
    const double INDEP_BAND_HI = 0.500;  // >= HI ⇒ COUPLED；[LO, HI) ⇒ INCONCLUSIVE
    const double coupleRatioForBand =
        (injCount > 0) ? (static_cast<double>(otherDrops) / static_cast<double>(injCount))
                       : -1.0;
    const bool coupledByDrops = (injCount > 0) && (coupleRatioForBand >= INDEP_BAND_HI);
    const bool bandInconclusive =
        (injCount > 0) && (coupleRatioForBand >= INDEP_BAND_LO) && (coupleRatioForBand < INDEP_BAND_HI);
    // ================= DEFECT-1 修正：P50 判据改为 P95 比值 =================
    // 事故：旧判据 `d = P50(stalled) - P50(clean) > 3.0ms` 在 **7/7 轮**上触发率 0，
    //       包括应该红的串行负控 ⇒ 恒假门（`MODE_SHARE` 恒真门的镜像）。
    // 根因（构造性，不是拟合）：注入是每 150ms 插 12ms stall，占空比 = 12/150 = 8%。
    //       中位数按定义不会被 8% 的样本移动 —— 它**永远**落在未受影响集合里。
    //       实测 7 轮 `OTHER_P50_DELTA_MS` 全为 -0.001~0.006ms，且这就是 P50 的读数
    //       分辨率，不是响应量。所以这不是"阈值定得太高"，是"量选错了"。
    //
    // 新判据（架构师 v2.4 §14.3 预置裁定）：
    //   CROSS_P95_RATIO = P95(另一窗 ∩ 注入窗) / P95(另一窗 ∩ 清洁窗)，门槛 1.5
    //   P95 落在最上面 5%，而受影响样本占 8% ⇒ 8% > 5% ⇒ P95 正好落在受影响集合内部。
    //   这是由占空比与百分位定义的算术关系，与机器无关。
    //   构造下界 = (12 + 6.06) / 6.20 = 2.91，取 1.5 距该下界留 1.94 倍余量，
    //   且比"完全无响应"的 1.0 高 50% ⇒ 两侧余量同数量级，不偏袒任一侧。
    //
    // ⚠ 与 §6.4 禁令 2 的关系：本判据按注入时刻对齐另一窗，是该禁令的**唯一豁免**，
    //   条件三条必须同时满足：
    //     (a) 只作交叉校验 —— 永不进 coupleRatio 或 INDEP_VERDICT（主判决仍只由
    //         COUPLED_BY_DROP_COUNT 决定）；
    //     (b) 函数名含 crosscheck（静态检查据此与主链区分）；
    //     (c) 输出必须带 CROSS_CHECK_ONLY=1，EMPTY_SET 时也要落该标记。
    //   禁令 2 立法要防的是「用时间窗对齐**决定**耦合」，而交叉校验是事后旁证，
    //   判错不改变主判决 —— 同一技术用在"决定"上致命，用在"检验"上有价值。
    const double CROSS_P95_THRESHOLD = 1.5;
    const bool crossP95Empty = otherGapsUnderStall.empty() || otherGapsClean.empty();
    double crossP95Ratio = -1.0;
    if (!crossP95Empty) {
      const double p95Stall = Percentile(otherGapsUnderStall, 0.95);
      const double p95Clean = Percentile(otherGapsClean, 0.95);
      // 分母为 0 时不得输出 inf/nan —— 这是 NC-3 零分母的同构错误。
      if (p95Clean > 0.0) crossP95Ratio = p95Stall / p95Clean;
    }
    // 交叉判据：EMPTY_SET 时判据不可用（**不得当通过**），只作旁证不进主判决。
    const bool coupledByWindow = !crossP95Empty && (crossP95Ratio > CROSS_P95_THRESHOLD);
    printf("CROSS_CHECK_ONLY=1 CROSS_P95_RATIO=%.4f CROSS_P95_THRESHOLD=%.2f "
           "CROSS_P95_STATE=%s\n",
           crossP95Ratio, CROSS_P95_THRESHOLD,
           crossP95Empty ? "EMPTY_SET(不可用，不得当通过)"
                         : (coupledByWindow ? "TRIGGERED" : "NOT_TRIGGERED"));
    if (zeroDenominator) {
      // 无分母 ⇒ 两条判据都无定义。这里**不打印 0/1**，避免下游把它当布尔读。
      printf("COUPLED_BY_DROP_COUNT=UNMEASURABLE COUPLED_BY_TIME_WINDOW=%d\n",
             coupledByWindow ? 1 : 0);
    } else {
      printf("COUPLED_BY_DROP_COUNT=%d COUPLED_BY_TIME_WINDOW=%d\n", coupledByDrops ? 1 : 0,
             coupledByWindow ? 1 : 0);
    }
    printf("INDEP_BAND lo=%.3f hi=%.3f coupleRatio=%.6f band=%s\n", INDEP_BAND_LO, INDEP_BAND_HI,
           coupleRatioForBand,
           zeroDenominator ? "UNDEFINED"
                           : (coupledByDrops ? "COUPLED"
                                             : (bandInconclusive ? "INCONCLUSIVE" : "INDEPENDENT")));
    const char* verdict = zeroDenominator ? "UNMEASURABLE"
                                          : (coupledByDrops ? "COUPLED"
                                                            : (bandInconclusive ? "UNMEASURABLE"
                                                                                : "INDEPENDENT"));
    printf("INDEP_VERDICT=%s\n", verdict);
    if (bandInconclusive) {
      printf("INDEP_UNMEASURABLE_REASON=BAND_AMBIGUOUS "
             "(coupleRatio=%.6f 落在 [%.3f, %.3f) 中间带：既超出独立上界、又够不上耦合下界。"
             "**判据不可判，不判 A 差** —— 对应 §2.4 状态转移表第 3 行)\n",
             coupleRatioForBand, INDEP_BAND_LO, INDEP_BAND_HI);
    }
    if (zeroDenominator) {
      printf("INDEP_UNMEASURABLE_REASON=ZERO_DENOMINATOR "
             "(injectCount=0：本轮没有注入，\"另一窗是否被拖住\"这个问题不成立。"
             "**这不是 INDEPENDENT**，也不是 COUPLED —— 本轮对该判据无信息)\n");
    }
    // 两条判据方向一致才写 STRONG，否则标 OUT_OF_AGREEMENT（要求人工复核）
    if (zeroDenominator) {
      printf("INDEP_AGREEMENT=UNDEFINED (掉拍计数判据无定义，交叉校验无从谈起)\n");
    } else if (bandInconclusive) {
      // 中间带：主判据本身不可判，交叉校验无从比对；不得写成 STRONG。
      printf("INDEP_AGREEMENT=UNDEFINED (主判据落中间带 BAND_AMBIGUOUS，无判决可交叉校验)\n");
    } else if (!crossP95Empty && (coupledByDrops != coupledByWindow)) {
      printf("INDEP_AGREEMENT=OUT_OF_AGREEMENT (掉拍计数与时间窗口判据不一致，需复核)\n");
    } else {
      printf("INDEP_AGREEMENT=STRONG\n");
    }
  }

  // ---- 仪器分辨力正样本：注入窗自己必须有明显长间隔 ----
  {
    const auto& inj = pw[cfg.injectWin];
    std::vector<double> underStall, clean;
    // injFlags 语义说明：记录的是「该样本本身是否被注入」。
    // 间隔 gaps[k] = samples[k+1] - samples[k]，而注入的 Sleep 发生在 samples[k]
    // 记录之后、samples[k] 与 samples[k+1] 之间 —— 所以拖长的是 gaps[k]。
    // 因此用 injFlags[k]（samples[k] 的注入标志）索引 gaps[k] 是正确的。
    for (size_t k = 0; k < inj.gaps.size() && k < inj.injFlags.size(); ++k) {
      if (inj.injFlags[k]) underStall.push_back(inj.gaps[k]);
      else clean.push_back(inj.gaps[k]);
    }
    const double ps = Percentile(underStall, 0.50);
    const double pc = Percentile(clean, 0.50);
    printf("\n--- 仪器分辨力正样本（注入窗自身的间隔变化）---\n");
    printf("INJ_WIN_UNDER_STALL_N=%zu P50=%.4f\n", underStall.size(), ps);
    printf("INJ_WIN_CLEAN_N=%zu P50=%.4f\n", clean.size(), pc);
    // 🔴 空集同样不能判 EFFECTIVE（空集 P50=0，ps > pc*1.5 恒假 -> 恒判 INEFFECTIVE，
    // 虽然方向是安全的，但会误导成"注入没生效"，其实是"没匹配到样本"）。
    // 空集有**两种**成因，必须分开写明，否则又是一句"看起来正常"的话：
    //   ① `injectCount=0`（根本没注入，如 `--stall-ms=0`）→ NO_INJECTION
    //   ② `injectCount>0` 但时间对齐没匹配上 → NO_MATCHED_SAMPLE
    if (underStall.empty()) {
      printf("INJECTION_VERDICT=INJECTION_UNDEFINED (reason=%s)\n",
             (pw[cfg.injectWin].injected == 0) ? "NO_INJECTION" : "NO_MATCHED_SAMPLE");
    } else {
      printf("INJECTION_VERDICT=%s\n",
             ps > pc * 1.5 ? "INJECTION_EFFECTIVE" : "INJECTION_INEFFECTIVE");
    }
  }

  // 🔴 解读规则段：**所有行必须以 RULE_ 开头，绝不许复用判决量前缀**。
  // 事故（本轮实际发生）：这里曾写 `printf("INDEP_VERDICT=UNMEASURABLE (ZERO_DENOMINATOR) => ...")`
  // —— 它是**无条件 printf 常量**，却在文本上长得和真正的判决行一模一样。
  // 后果：任何 `grep "INDEP_VERDICT="` 都会在**每一份日志**里命中它，
  // 于是一轮明明判 INDEPENDENT 的输出里同时出现 UNMEASURABLE，
  // 下游（包括我自己的核对脚本）会以为该轮是零分母轮。
  // 这是教训 #36「同一个可疑行要定位它是 printf 常量还是分支产物」的复发形态：
  // 根因不是"读得不够仔细"，而是**规则行借用了判决量的 KEY**，让人无法靠 KEY 区分。
  // 规矩：规则/说明行的 KEY 一律 `RULE_` 前缀，判决量的 KEY 只由分支产出。
  printf("\n--- 解读规则（RULE_ 前缀 = 无条件常量，不是判决结果）---\n");
  printf("RULE_INJECTION_INEFFECTIVE => 本轮无分辨力，INDEP_VERDICT 不可采信\n");
  printf("RULE_ZERO_DENOMINATOR => 本轮无注入，coupleRatio=null，两条判据都无定义；\n");
  printf("    它既不是 INDEPENDENT 也不是 COUPLED，**不得计入任何一侧的统计**\n");
  printf("RULE_BAND_AMBIGUOUS => coupleRatio 落在 [0.050, 0.500)，判据不可判；\n");
  printf("    对应 §2.4 状态转移表第 3 行，**不判 A 差**，也不计入任何一侧\n");
  printf("RULE_EFFECTIVE_PLUS_INDEPENDENT => 两链独立，D1 层间独立性方案成立\n");
  printf("RULE_EFFECTIVE_PLUS_COUPLED    => 两链耦合，D1 需降 blocked\n");

  // ============ AC6 结构判别式：DRIFT_FRAMES（架构师 v2.4 §14.2 预置裁定）============
  // 公式（**逐字照抄架构师定义，不得改用端点差法**）：
  //   DRIFT_FRAMES := | median(diff[k], k ∈ 后10%) − median(diff[k], k ∈ 前10%) | / medianIntervalUs
  //   diff[k] = win0.relUs[k] − win1.relUs[k]（按 k 对位相减，两窗各按自己的样本序）
  //
  // 为什么分子必须是「漂移」而不是「标准差」（v2.3 的 std 判别式作废的理由）：
  //   std(diff) 把「漂移」与「抖动」相加。两臂抖动同量级，差别全在漂移。
  //   用 std 判"有没有漂移"= 用"抖动+漂移"当"漂移"的代理 ⇒ 抖动大的臂被顶过阈值。
  //   v2.3 实测：串行臂 std 口径得分 0.2292 > 0.20，被判成"并行" ⇒ 该判别式在串行臂上恒假。
  //   改用首尾中位数差：零均值抖动被压 O(1/√n)（n≈990 ⇒ 压 31.5 倍），漂移是单边累积，
  //   取首尾两段的中位数差恰好读到累积量本身 —— 抖动再大，只要不累积，这个差就接近 0。
  //
  // ⚠ 已知缺陷 DEFECT-6（必须在报告里显式说明）：架构师 §14.2 的**兼容性表**里列的
  //   `56.1012 / 0.019` 是「端点差法」( diff[last]-diff[0] )，不是本公式的数。
  //   按本公式复算同两份 JSONL 得 `47.3967 / 0.0017`。两法判决方向一致（>5.0 / <1.0），
  //   但**表里的数值与表头公式不对应**。本实现按**公式**落地（更稳：用 983 个样本而非 1 个）。
  {
    const auto& s0 = host.slots[0].samples;
    const auto& s1 = host.slots[1].samples;
    const size_t n = s0.size() < s1.size() ? s0.size() : s1.size();
    const double DRIFT_SERIAL_MAX = 1.0;   // 串行上界（帧）
    const double DRIFT_PARALLEL_MIN = 5.0; // 并行下界（帧）
    if (n < 5000) {
      // 架构师明确：n < 5000 对（低于 60s）一律 INCONCLUSIVE
      printf("AC6_DRIFT_FRAMES=INSUFFICIENT_PAIRS n=%zu (<5000，低于 60s) "
             "AC6_VERDICT=INCONCLUSIVE (不判 fail、不计入证据)\n", n);
    } else {
      std::vector<double> diff;
      diff.reserve(n);
      for (size_t k = 0; k < n; ++k)
        diff.push_back(static_cast<double>(s0[k].qpcUs) - static_cast<double>(s1[k].qpcUs));
      std::vector<double> intervals;
      intervals.reserve(s0.size());
      for (size_t k = 1; k < s0.size(); ++k)
        intervals.push_back(static_cast<double>(s0[k].qpcUs - s0[k - 1].qpcUs));
      const double medInt = Percentile(intervals, 0.50);
      const size_t k10 = n / 10 > 0 ? n / 10 : 1;
      std::vector<double> headD(diff.begin(), diff.begin() + static_cast<long>(k10));
      std::vector<double> tailD(diff.end() - static_cast<long>(k10), diff.end());
      const double headMed = Percentile(headD, 0.50);
      const double tailMed = Percentile(tailD, 0.50);
      const double driftFrames = (medInt > 0.0) ? std::fabs(tailMed - headMed) / medInt : -1.0;
      const char* ac6 = (driftFrames < DRIFT_SERIAL_MAX)  ? "SERIAL"
                        : (driftFrames > DRIFT_PARALLEL_MIN) ? "PARALLEL"
                                                              : "INCONCLUSIVE";
      printf("AC6_DRIFT_FRAMES=%.4f n_pairs=%zu k10=%zu headMedUs=%.1f tailMedUs=%.1f "
             "medianIntervalUs=%.1f bands=[serial<%.1f, parallel>%.1f] AC6_VERDICT=%s "
             "(单位=帧，无量纲；inconclusive 带 [%.1f,%.1f] 不判 fail、不计证据)\n",
             driftFrames, n, k10, headMed, tailMed, medInt, DRIFT_SERIAL_MAX, DRIFT_PARALLEL_MIN,
             ac6, DRIFT_SERIAL_MAX, DRIFT_PARALLEL_MIN);
    }
  }

  host.Shutdown();
  printf("SHUTDOWN=OK\nEXIT=0\n");
  fflush(stdout);
  return 0;
}