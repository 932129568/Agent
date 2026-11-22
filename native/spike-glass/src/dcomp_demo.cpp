// dcomp_demo.cpp —— 通路 A「双窗 + DirectComposition」可运行 Demo（T02 的 DoD 核心）
//
// 两个独立的 WS_EX_NOREDIRECTIONBITMAP 窗口，各自一条 CreateSwapChainForComposition 交换链，
// 由 DirectComposition 分别合成。节拍 = Present1(SyncInterval=1) + frameLatencyWaitable。
//
// 命令行：
//   --frames N        帧循环总帧数（默认 300）
//   --no-selftest     跳过 DDA_SELFTEST
//   --sync=0|1        Present1 的 SyncInterval（默认 1；=0 是 NC-A1 负控）
//   --skip-commit     NC-A2 负控：跳过 dc->Commit()
//   --offset15x       NC-A3 负控：DDA 读取坐标故意乘 1.5
//   --dcomp-api=dxgi|c2  DComp 设备建法（默认 dxgi = DCompositionCreateDevice(dxgiDevice)）
//   --hold-ms N       自证通过后保持窗口可见的毫秒数（默认 0）
//
// stdout 全部是 `KEY=VALUE` 行，可被脚本 grep。日志走 stdout 且每行 fflush。

#include "dcomp_host.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

using harbor::spike_a::Bgra8;
using harbor::spike_a::DcompDeviceApi;
using harbor::spike_a::DpiMode;
using harbor::spike_a::HostWindowSpec;
using harbor::spike_a::HrLog;
using harbor::spike_a::SpikeDCompHost;
using harbor::spike_a::VerifyOptions;
using harbor::spike_a::VerifyResult;

struct Options {
  int frames = 300;
  bool selftest = true;
  int sync_interval = 1;
  bool skip_commit = false;
  bool offset_15x = false;
  DcompDeviceApi dcomp_api = DcompDeviceApi::kCreateDeviceFromDxgi;
  int hold_ms = 0;
  bool parse_ok = true;
  std::string parse_error;
};

int ParseInt(const char* text, bool* ok) {
  if (!text || !*text) { *ok = false; return 0; }
  char* end = nullptr;
  const long v = std::strtol(text, &end, 10);
  *ok = (end && *end == '\0');
  return static_cast<int>(v);
}

bool StartsWith(const char* s, const char* prefix) {
  return std::strncmp(s, prefix, std::strlen(prefix)) == 0;
}

Options ParseArgs(int argc, wchar_t** argv) {
  Options o;
  for (int i = 1; i < argc; ++i) {
    // 宽字符转窄字符：参数全是 ASCII，逐字节截断即可。
    char arg[256] = {};
    for (int k = 0; k < 255 && argv[i][k]; ++k) {
      arg[k] = (argv[i][k] < 128) ? static_cast<char>(argv[i][k]) : '?';
    }
    bool ok = true;
    if (std::strcmp(arg, "--no-selftest") == 0) {
      o.selftest = false;
    } else if (std::strcmp(arg, "--skip-commit") == 0) {
      o.skip_commit = true;
    } else if (std::strcmp(arg, "--offset15x") == 0) {
      o.offset_15x = true;
    } else if (StartsWith(arg, "--frames=")) {
      o.frames = ParseInt(arg + 9, &ok);
      if (!ok || o.frames <= 0) { o.parse_ok = false; o.parse_error = "BAD_FRAMES"; }
    } else if (StartsWith(arg, "--sync=")) {
      o.sync_interval = ParseInt(arg + 7, &ok);
      if (!ok || o.sync_interval < 0) { o.parse_ok = false; o.parse_error = "BAD_SYNC"; }
    } else if (StartsWith(arg, "--dcomp-api=")) {
      const char* v = arg + 12;
      if (std::strcmp(v, "dxgi") == 0) {
        o.dcomp_api = DcompDeviceApi::kCreateDeviceFromDxgi;
      } else if (std::strcmp(v, "c2") == 0 || std::strcmp(v, "null") == 0) {
        o.dcomp_api = DcompDeviceApi::kCreateDevice2Null;
      } else {
        o.parse_ok = false;
        o.parse_error = "BAD_DCOMP_API";
      }
    } else if (StartsWith(arg, "--hold-ms=")) {
      o.hold_ms = ParseInt(arg + 10, &ok);
      if (!ok || o.hold_ms < 0) { o.parse_ok = false; o.parse_error = "BAD_HOLD_MS"; }
    } else if (std::strcmp(arg, "--help") == 0 || std::strcmp(arg, "-h") == 0) {
      o.parse_ok = false;
      o.parse_error = "HELP";
    } else {
      o.parse_ok = false;
      o.parse_error = "UNKNOWN_ARG";
    }
  }
  return o;
}

void PrintUsage() {
  printf("usage: dcomp_demo.exe [--frames=N] [--no-selftest] [--sync=0|1]\n");
  printf("                      [--skip-commit] [--offset15x]\n");
  printf("                      [--dcomp-api=dxgi|c2] [--hold-ms=N]\n");
  fflush(stdout);
}

// 百分比（nearest-rank，与 calib.cpp 口径一致）。
double Percentile(std::vector<double> values, double p) {
  if (values.empty()) return 0.0;
  std::sort(values.begin(), values.end());
  const double idx = p * static_cast<double>(values.size() - 1);
  const size_t lo = static_cast<size_t>(idx);
  const size_t hi = lo + 1 < values.size() ? lo + 1 : lo;
  const double frac = idx - static_cast<double>(lo);
  return values[lo] * (1.0 - frac) + values[hi] * frac;
}

struct FrameStats {
  uint64_t frames = 0;
  double loop_p50 = 0.0;
  double loop_p95 = 0.0;
  double loop_p99 = 0.0;
  double loop_max = 0.0;
  // 单帧 CPU 时间 = 清屏 + Present1 + Wait 三段之和（不含循环尾巴）。
  double cpu_p50 = 0.0;
  double cpu_p95 = 0.0;
  double cpu_p99 = 0.0;
  double cpu_max = 0.0;
  double window_span_ms = 0.0;
  int waits_timeout = 0;
  int waits_failed = 0;
  // 掉拍：间隔 >= 2 个 vsync 基准（基准取实测 loop 间隔中位数，不用理论 6.06ms）。
  double vsync_base_ms = 0.0;
  int drops = 0;
  double drop_rate = 0.0;
};

void PumpMessages() {
  MSG msg;
  while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
}

// 帧循环。每帧：清屏 → Present1 → Wait（每窗一次）。
// CPU_FRAME_MS 定义为「一帧内从开始清屏到所有窗 wait 完成」的墙钟时间：
//   SyncInterval=1 时它被 vsync 钉在 1/hz（165Hz → 6.06ms）；
//   SyncInterval=0 时 waitable 瞬间放行，它掉到 0.15ms 级（NC-A1 的判据）。
//
// ⚠ 这个量**不是 CPU 纯开销**（元规则第五条：同名不同物）。整圈墙钟包含 Wait 阻塞。
// CPU 纯开销应由采集器（native/build/m2probe/collector.cpp）的 SUBMIT_MS 承担：
// 帧起点 → Present1 之前。D2 的 CPU 维度只用 SUBMIT_MS；本文件只负责 pacing
// 与掉拍（主统计量的 ①②），两者分工不重叠。
//
// jsonl 非空时逐帧写一行（字段名与 collector 对齐，便于同一回读器校验）。
FrameStats RunFrames(SpikeDCompHost* host, int frames, int sync_interval,
                     FILE* jsonl) {
  FrameStats stats;
  const size_t n = host->WindowCount();

  LARGE_INTEGER freq;
  QueryPerformanceFrequency(&freq);
  auto NowMs = [&freq]() {
    LARGE_INTEGER t;
    QueryPerformanceCounter(&t);
    return static_cast<double>(t.QuadPart) * 1000.0 / static_cast<double>(freq.QuadPart);
  };

  std::vector<double> loop_ms;
  std::vector<double> cpu_ms;
  loop_ms.reserve(static_cast<size_t>(frames));
  cpu_ms.reserve(static_cast<size_t>(frames));

  LARGE_INTEGER start, end;
  QueryPerformanceCounter(&start);
  double prev_frame_start = NowMs();

  for (int f = 0; f < frames; ++f) {
    PumpMessages();
    const double frame_start = NowMs();

    // 两窗串行：窗1(清屏+Present) → 窗1 Wait → 窗2(清屏+Present) → 窗2 Wait。
    // submit 必须只累加各窗自己的 (清屏+Present) 段，**不能**用 "NowMs()-frame_start"，
    // 否则会把窗1的 Wait 算进 submit，导致 submit+wait > frame（实测 848+6005 > 6649）。
    // 这正是元规则第五条要拦的计时窗口重叠。
    double submit_ms = 0.0;
    double wait_ms = 0.0;
    for (size_t i = 0; i < n; ++i) {
      const auto& spec = host->Window(i).spec;
      const double w0 = NowMs();

      // 颜色必须逐帧保持精确：DDA_SELFTEST 拿它当期望值，任何渐变都会污染 ±8 容差。
      host->ClearWindow(i, spec.clear_color);
      host->PresentWindow(i, sync_interval);

      submit_ms += NowMs() - w0;

      const double wait_t0 = NowMs();
      const DWORD rc = host->WaitWindow(i, 250);
      wait_ms += NowMs() - wait_t0;

      if (rc == WAIT_TIMEOUT) ++stats.waits_timeout;
      else if (rc != WAIT_OBJECT_0 && rc != WAIT_ABANDONED) ++stats.waits_failed;
    }

    const double frame_end = NowMs();
    const double frame_ms = frame_end - frame_start;
    const double interval_ms = (f == 0) ? 0.0 : (frame_start - prev_frame_start);
    cpu_ms.push_back(frame_ms);
    loop_ms.push_back(frame_start - prev_frame_start);
    prev_frame_start = frame_start;

    if (jsonl) {
      fprintf(jsonl,
              "{\"frameIdx\":%d,\"intervalMs\":%.4f,\"submitUs\":%.1f,"
              "\"frameUs\":%.1f,\"waitUs\":%.1f,\"gpuPassUs\":-1,"
              "\"gpuValid\":0,\"syncInterval\":%d,\"waitable\":1,"
              "\"pathway\":\"A\"}\n",
              f, interval_ms, submit_ms * 1000.0, frame_ms * 1000.0,
              wait_ms * 1000.0, sync_interval);
    }
    ++stats.frames;
  }
  QueryPerformanceCounter(&end);

  stats.window_span_ms = static_cast<double>(end.QuadPart - start.QuadPart) * 1000.0 /
                         static_cast<double>(freq.QuadPart);

  stats.cpu_p50 = Percentile(cpu_ms, 0.50);
  stats.cpu_p95 = Percentile(cpu_ms, 0.95);
  stats.cpu_p99 = Percentile(cpu_ms, 0.99);
  stats.cpu_max = *std::max_element(cpu_ms.begin(), cpu_ms.end());
  if (loop_ms.size() > 1) {
    loop_ms.erase(loop_ms.begin());  // 首帧间隔含启动抖动，剔除
    stats.loop_p50 = Percentile(loop_ms, 0.50);
    stats.loop_p95 = Percentile(loop_ms, 0.95);
    stats.loop_p99 = Percentile(loop_ms, 0.99);
    stats.loop_max = *std::max_element(loop_ms.begin(), loop_ms.end());

    // 掉拍基准 = 实测间隔中位数（PRD D2②：不用理论 6.06ms，标称达不到时会假红）
    stats.vsync_base_ms = stats.loop_p50;
    if (stats.vsync_base_ms > 0.0) {
      const double threshold = stats.vsync_base_ms * 1.5;  // ">= 2 个节拍"的保守解释
      for (double v : loop_ms) {
        if (v >= threshold) ++stats.drops;
      }
      stats.drop_rate = static_cast<double>(stats.drops) /
                        static_cast<double>(loop_ms.size());
    }
  }
  return stats;
}

// 打印一个窗口的 DDA 自证行。格式固定，供脚本 grep：
//   DDA_SELFTEST_WIN1=PASS  coord=(x,y) inRect=1 color=(B,G,R,A) expect=(B,G,R,A) reason=OK
void PrintSelftestWindow(const VerifyResult& vr, size_t i) {
  const auto& w = vr.windows[i];
  printf("DDA_SELFTEST_WIN%zu=%s  coord=(%d,%d) inRect=%d color=(%u,%u,%u,%u) "
         "expect=(%u,%u,%u,%u) reason=%s\n",
         i + 1, w.pass() ? "PASS" : "FAIL", static_cast<int>(w.coord_x),
         static_cast<int>(w.coord_y), w.in_rect ? 1 : 0,
         static_cast<unsigned>(w.got.b), static_cast<unsigned>(w.got.g),
         static_cast<unsigned>(w.got.r), static_cast<unsigned>(w.got.a),
         static_cast<unsigned>(w.expect.b), static_cast<unsigned>(w.expect.g),
         static_cast<unsigned>(w.expect.r), static_cast<unsigned>(w.expect.a),
         w.FailReason());
}

}  // namespace

int WINAPI wWinMain(HINSTANCE hinst, HINSTANCE prev, PWSTR cmdline, int show) {
  (void)prev;
  (void)cmdline;
  (void)show;

  SetConsoleOutputCP(CP_UTF8);

  const int argc = __argc;
  wchar_t** argv = __wargv;
  Options opt = ParseArgs(argc, argv);
  if (!opt.parse_ok) {
    printf("ARGS_ERROR=%s\n", opt.parse_error.c_str());
    PrintUsage();
    fflush(stdout);
    return 2;
  }

  printf("DEMO=dcomp_demo\n");
  printf("FRAMES=%d\n", opt.frames);
  printf("SYNC_INTERVAL=%d\n", opt.sync_interval);
  printf("SKIP_COMMIT=%d\n", opt.skip_commit ? 1 : 0);
  printf("OFFSET_15X=%d\n", opt.offset_15x ? 1 : 0);
  printf("DCOMP_API=%s\n", harbor::spike_a::DcompDeviceApiName(opt.dcomp_api));
  fflush(stdout);

  HrLog hr_log;

  // 🔴 DPI 感知必须最先设置，且失败不许静默继续。
  const DpiMode dpi_mode = SpikeDCompHost::InitDpi(&hr_log);
  if (dpi_mode == DpiMode::kFailed) {
    hr_log.Report(stdout);
    printf("DPI_MODE=%s\n", harbor::spike_a::DpiModeName(dpi_mode));
    printf("DPI_INIT=FAIL\n");
    fprintf(stderr, "[FATAL] DPI awareness could not be set; window coords would be off by 1.5x\n");
    fflush(stdout);
    return 3;
  }
  printf("DPI_MODE=%s\n", harbor::spike_a::DpiModeName(dpi_mode));
  printf("DPI_AWARENESS=%s\n", SpikeDCompHost::CurrentDpiAwarenessName());
  printf("SM_CXSCREEN=%d\n", GetSystemMetrics(SM_CXSCREEN));
  printf("SM_CYSCREEN=%d\n", GetSystemMetrics(SM_CYSCREEN));
  fflush(stdout);

  SpikeDCompHost host;
  host.SetSkipCommit(opt.skip_commit);

  if (!host.Init(hinst, false, opt.dcomp_api, &hr_log)) {
    hr_log.Report(stdout);
    printf("INIT=FAIL\n");
    fflush(stdout);
    return 4;
  }
  printf("ADAPTER_NAME=%ls\n", host.adapter_name());
  printf("ADAPTER_LUID=0x%08lX:0x%08lX\n", static_cast<unsigned long>(host.adapter_luid().HighPart),
         static_cast<unsigned long>(host.adapter_luid().LowPart));
  printf("FEATURE_LEVEL=0x%X\n", static_cast<unsigned>(host.feature_level()));
  printf("INIT=OK\n");
  fflush(stdout);

  // 两个窗口：480×360（品红）与 320×240（青），错开摆放。
  // 摆放位置有约束：NC-A3 会把中心坐标乘 1.5 模拟 DPI UNAWARE 的错误换算，必须保证
  // 乘完落到窗口矩形之外（条件：left > width/2 且 top > height/2），否则负控会退化
  // 成「颜色不符」而不是「坐标不在窗内」。下面两组值都满足该条件。
  HostWindowSpec spec1;
  spec1.class_name = L"HarborSpikeAWin1";
  spec1.title = L"Harbor Spike A Window 1";
  spec1.x = 300;
  spec1.y = 200;
  spec1.width = 480;
  spec1.height = 360;
  spec1.clear_color[0] = 1.0f;
  spec1.clear_color[1] = 0.0f;
  spec1.clear_color[2] = 1.0f;
  spec1.clear_color[3] = 1.0f;

  HostWindowSpec spec2;
  spec2.class_name = L"HarborSpikeAWin2";
  spec2.title = L"Harbor Spike A Window 2";
  spec2.x = 760;
  spec2.y = 620;
  spec2.width = 320;
  spec2.height = 240;
  spec2.clear_color[0] = 0.0f;
  spec2.clear_color[1] = 1.0f;
  spec2.clear_color[2] = 1.0f;
  spec2.clear_color[3] = 1.0f;

  if (!host.AddWindow(spec1, &hr_log)) {
    hr_log.Report(stdout);
    printf("ADD_WINDOW1=FAIL\n");
    fflush(stdout);
    return 5;
  }
  printf("WINDOW1=%dx%d@(%d,%d) clear=(1,0,1,1)\n", spec1.width, spec1.height, spec1.x, spec1.y);
  if (!host.AddWindow(spec2, &hr_log)) {
    hr_log.Report(stdout);
    printf("ADD_WINDOW2=FAIL\n");
    fflush(stdout);
    return 6;
  }
  printf("WINDOW2=%dx%d@(%d,%d) clear=(0,1,1,1)\n", spec2.width, spec2.height, spec2.x, spec2.y);
  printf("HWND_WIN1=0x%llX\n", static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(host.Window(0).hwnd)));
  printf("HWND_WIN2=0x%llX\n", static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(host.Window(1).hwnd)));
  printf("IS_WINDOW_VISIBLE_WIN1=%d\n", IsWindowVisible(host.Window(0).hwnd) ? 1 : 0);
  printf("IS_WINDOW_VISIBLE_WIN2=%d\n", IsWindowVisible(host.Window(1).hwnd) ? 1 : 0);
  fflush(stdout);

  // 先画一帧（未 Present 的交换链内容不会上屏，自证前必须有内容）。
  for (size_t i = 0; i < host.WindowCount(); ++i) {
    host.ClearWindow(i, host.Window(i).spec.clear_color);
    host.PresentWindow(i, opt.sync_interval);
    host.WaitWindow(i, 500);
  }
  PumpMessages();
  Sleep(150);  // 给 DWM 一点时间真正合成上去

  // D2 主统计量需要 p99 与掉拍的原始样本，故提供逐帧 JSONL（DCOMP_JSONL 指定路径）
  FILE* jsonl = nullptr;
  const char* jsonlPath = getenv("DCOMP_JSONL");
  if (jsonlPath && *jsonlPath) {
    if (fopen_s(&jsonl, jsonlPath, "wb") != 0) {
      printf("JSONL_OPEN=FAIL path=%s\n", jsonlPath);
      jsonl = nullptr;
    } else {
      printf("JSONL_OPEN=OK path=%s\n", jsonlPath);
    }
  }

  FrameStats stats = RunFrames(&host, opt.frames, opt.sync_interval, jsonl);
  if (jsonl) { fclose(jsonl); jsonl = nullptr; }
  PumpMessages();

  // ---- 统计输出 -------------------------------------------------------------
  printf("FRAMES_DONE=%llu\n", static_cast<unsigned long long>(stats.frames));
  printf("WALL_SPAN_MS=%.3f\n", stats.window_span_ms);
  printf("CPU_FRAME_MS_P50=%.4f\n", stats.cpu_p50);
  printf("CPU_FRAME_MS_P95=%.4f\n", stats.cpu_p95);
  printf("CPU_FRAME_MS_P99=%.4f\n", stats.cpu_p99);
  printf("CPU_FRAME_MS_MAX=%.4f\n", stats.cpu_max);
  printf("LOOP_PERIOD_MS_P50=%.4f\n", stats.loop_p50);
  printf("LOOP_PERIOD_MS_P95=%.4f\n", stats.loop_p95);
  printf("LOOP_PERIOD_MS_P99=%.4f\n", stats.loop_p99);
  printf("LOOP_PERIOD_MS_MAX=%.4f\n", stats.loop_max);
  printf("VSYNC_BASE_MS=%.4f\n", stats.vsync_base_ms);
  printf("DROPS=%d\n", stats.drops);
  printf("DROP_RATE=%.5f\n", stats.drop_rate);
  if (stats.window_span_ms > 0.0) {
    // 每窗各自的帧率：帧循环是「每帧把所有窗都 Present 一遍」，故 span 覆盖 frames 帧。
    printf("FRAMES_PER_SEC_PER_WINDOW=%.2f\n",
           static_cast<double>(stats.frames) * 1000.0 / stats.window_span_ms);
  }
  printf("WAITS_TIMEOUT=%d\n", stats.waits_timeout);
  printf("WAITS_FAILED=%d\n", stats.waits_failed);
  for (size_t i = 0; i < host.WindowCount(); ++i) {
    printf("PRESENTS_WIN%zu=%llu\n", i + 1,
           static_cast<unsigned long long>(host.Window(i).presents));
    printf("WAITS_WIN%zu=%llu\n", i + 1,
           static_cast<unsigned long long>(host.Window(i).waits_ok));
  }
  fflush(stdout);

  // ---- DDA_SELFTEST --------------------------------------------------------
  int selftest_exit = 0;
  if (opt.selftest) {
    VerifyOptions vopt;
    vopt.offset_15x = opt.offset_15x;
    VerifyResult vr;
    const bool ok = harbor::spike_a::VerifyOnScreen(&host, vopt, &vr, &hr_log);

    printf("DDA_AVAILABLE=%d\n", vr.dda_available ? 1 : 0);
    printf("DDA_DUP_HR=0x%08lX\n", static_cast<unsigned long>(vr.dup_hr));
    printf("DDA_ACQUIRE_LAST_HR=0x%08lX\n", static_cast<unsigned long>(vr.acquire_last_hr));
    printf("DDA_SURFACE=%ux%u\n", vr.surface_width, vr.surface_height);
    printf("DDA_FRAMES_ACQUIRED=%u\n", vr.frames_acquired);
    printf("DDA_ATTEMPTS_USED=%u\n", vr.attempts_used);
    printf("DDA_TIMED_OUT=%d\n", vr.timed_out ? 1 : 0);
    for (size_t i = 0; i < vr.windows.size(); ++i) PrintSelftestWindow(vr, i);
    printf("DDA_SELFTEST=%s\n", ok ? "PASS" : "FAIL");
    printf("DDA_SELFTEST_REASON=%s\n", vr.FailReason());
    printf("COMMIT_SKIPPED_COUNT=%u\n", host.commit_skips());
    fflush(stdout);
    selftest_exit = ok ? 0 : 10;
  } else {
    printf("DDA_SELFTEST=SKIPPED\n");
    fflush(stdout);
  }

  // ---- HRESULT 台账 --------------------------------------------------------
  hr_log.Report(stdout);

  if (opt.hold_ms > 0) {
    const ULONGLONG until = GetTickCount64() + static_cast<ULONGLONG>(opt.hold_ms);
    while (GetTickCount64() < until) {
      PumpMessages();
      Sleep(16);
    }
  }

  // 显式 Shutdown（~SpikeDCompHost 也会调，幂等；这里显式调是为了让 released 统计落在 exit 之前）。
  host.Shutdown();
  PumpMessages();
  printf("SHUTDOWN=OK\n");
  printf("EXIT=%d\n", selftest_exit);
  fflush(stdout);
  return selftest_exit;
}