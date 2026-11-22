// osr_host.cpp -- 通路 B: 原生 DComp 宿主（WS_EX_NOREDIRECTIONBITMAP + 单条合成交换链）
//
// 职责边界:
//   * 本文件只负责"把一张 NT 共享纹理合成到一条交换链上并 Present"。
//   * 打开句柄的细节在 osr_bridge.cpp；Electron 侧的出帧节奏在 osr_demo.js。
//
// 线程模型:
//   Init() 起一个专属工作线程，窗口 / D3D11 设备 / DXGI 交换链 / DComp 树 / 消息泵 / 渲染循环
//   全部在该线程创建与运行。主线程（Electron main）只做 SubmitSharedTexture()：
//   OpenSharedResource1 + CreateShaderResourceView 是设备级调用（D3D11 设备默认线程安全），
//   微秒级、不阻塞，做完即可让 JS 侧 release Electron 的 texture。
//
// 【为什么不跨进程传句柄】
//   任务书允许 named pipe / argv / addon 桥接三种。选 addon 桥接：句柄在 Electron 主进程里
//   本来就是有效的（paint 事件直接给到主进程），跨进程 DuplicateHandle 只会多一个失败面
//   （需要 PROCESS_DUP_HANDLE，且 Chromium 一旦回收纹理句柄就失效）。进程内桥接把这个
//   竞态彻底消掉。

#include "osr_host.h"

// D2 主统计量需要全样本排序（std::sort）与可增长容器（std::vector）。
// 放在这里而不是靠其它头间接带入 —— 间接 include 会随 SDK/编译器版本变化，
// 一旦断掉就是 C2039/C2065 这类"看起来无关"的错。
#include <algorithm>
#include <vector>

// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 / SetProcessDpiAwarenessContext / GetDpiForWindow
// 都在 winuser.h 的 WINVER >= 0x0A00 分支里。显式抬高版本门槛，避免 SDK 默认值不足时
// 报 C2065（未声明标识符）这种看似无关的错。
#ifndef WINVER
#define WINVER 0x0A00
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>

#include <d3d11_1.h>
#include <d3dcompiler.h>
#include <dcomp.h>
#include <dxgi1_6.h>

#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <condition_variable>
#include <thread>

#include "osr_bridge.h"

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "dcomp.lib")
#pragma comment(lib, "d3dcompiler.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "ole32.lib")

namespace harbor {
namespace osr {
namespace {

constexpr wchar_t kWindowClass[] = L"HarborOsrHostWnd";

// node-gyp 不定义 UNICODE/_UNICODE，此时 IDC_ARROW 展开成 MAKEINTRESOURCEA(32512)
// （LPSTR），而 RegisterClassExW 的 WNDCLASSEXW.hCursor 要 LPCWSTR —— 直接报 C2664。
// 这里显式走 W 版本宏，不依赖工程的字符集设置。
#ifdef UNICODE
#define HARBOR_IDC_ARROW IDC_ARROW
#else
#define HARBOR_IDC_ARROW MAKEINTRESOURCEW(32512)  // IDC_ARROW 的资源 ID
#endif

// 全屏三角形 blit：不需要顶点缓冲，直接用 SV_VertexID 生成覆盖整个视口的一个大三角。
// UV 做了 Y 翻转 —— D3D 纹理原点在左上，而裁剪空间 +Y 向上。
constexpr char kBlitHlsl[] = R"HLSL(
struct VSOut {
  float4 pos : SV_Position;
  float2 uv  : TEXCOORD0;
};

VSOut VSMain(uint id : SV_VertexID) {
  VSOut o;
  float2 p = float2((id == 2) ? 3.0 : -1.0, (id == 1) ? 3.0 : -1.0);
  o.pos = float4(p, 0.0, 1.0);
  o.uv  = float2((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
  return o;
}

Texture2D<float4>  uiTex : register(t0);
SamplerState       uiSmp : register(s0);

float4 PSMain(VSOut i) : SV_Target {
  return uiTex.Sample(uiSmp, i.uv);
}
)HLSL";

double NowMs() {
    static LARGE_INTEGER freq = [] {
        LARGE_INTEGER f = {};
        QueryPerformanceFrequency(&f);
        return f;
    }();
    LARGE_INTEGER counter = {};
    QueryPerformanceCounter(&counter);
    return static_cast<double>(counter.QuadPart) * 1000.0 /
           static_cast<double>(freq.QuadPart);
}

void SetErr(char* errText, size_t errTextLen, const char* fmt, ...) {
    if (errText == nullptr || errTextLen == 0) return;
    va_list args;
    va_start(args, fmt);
    std::vsnprintf(errText, errTextLen, fmt, args);
    va_end(args);
}

bool CompileShader(const char* entry,
                   const char* target,
                   ID3DBlob** outBlob,
                   char* errText,
                   size_t errTextLen) {
    ID3DBlob* errorBlob = nullptr;
    const UINT flags = D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3;
    HRESULT hr = D3DCompile(kBlitHlsl, sizeof(kBlitHlsl) - 1, "harbor_osr_blit.hlsl",
                            nullptr, nullptr, entry, target, flags, 0, outBlob,
                            &errorBlob);
    if (FAILED(hr)) {
        if (errorBlob != nullptr) {
            SetErr(errText, errTextLen, "%s(%s) compile failed hr=0x%08X: %.160s",
                   entry, target, static_cast<unsigned int>(hr),
                   static_cast<const char*>(errorBlob->GetBufferPointer()));
            errorBlob->Release();
        } else {
            SetErr(errText, errTextLen, "%s(%s) compile failed hr=0x%08X",
                   entry, target, static_cast<unsigned int>(hr));
        }
        return false;
    }
    if (errorBlob != nullptr) errorBlob->Release();
    return true;
}

}  // namespace

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------
struct HarborOsrHost::Impl {
    HarborOsrHostConfig cfg;

    // 线程与握手
    std::thread worker;
    mutable std::mutex mu;
    std::condition_variable cv;
    std::atomic<bool> stop{false};
    bool initDone = false;
    bool initOk = false;
    char initErr[512] = {0};
    bool ready = false;

    // 帧槽（只保留最新一帧）
    bool hasFrame = false;
    ID3D11Texture2D* slotTex = nullptr;
    ID3D11ShaderResourceView* slotSrv = nullptr;
    unsigned long long slotSeq = 0;

    // GPU / 窗口对象（Init 之后只读，或仅由工作线程访问）
    HWND hwnd = nullptr;
    ID3D11Device* device = nullptr;
    ID3D11Device1* device1 = nullptr;
    ID3D11DeviceContext* ctx = nullptr;
    IDXGISwapChain1* swapChain = nullptr;
    IDXGISwapChain2* swapChain2 = nullptr;
    HANDLE frameWaitable = nullptr;
    IDCompositionDevice* dcomp = nullptr;
    IDCompositionTarget* dcompTarget = nullptr;
    IDCompositionVisual* dcompVisual = nullptr;
    ID3D11RenderTargetView* rtv = nullptr;
    ID3D11VertexShader* vs = nullptr;
    ID3D11PixelShader* ps = nullptr;
    ID3D11SamplerState* sampler = nullptr;

    // 首帧尺寸同步标记（见 SyncSwapChainToTexture）
    bool sizeSynced = false;

    // 像素恒等自证: 快照最后一帧（宿主私有副本，非共享纹理引用）
    std::atomic<bool> paused{false};
    std::atomic<bool> retainLastFrame{false};
    // 私有快照纹理（内容稳定，可安全比对）
    ID3D11Texture2D* snapshotTex = nullptr;
    UINT snapshotWidth = 0;
    UINT snapshotHeight = 0;
    DXGI_FORMAT snapshotFormat = DXGI_FORMAT_UNKNOWN;

    // 统计
    HarborOsrHostStats stats;
    double presentMsSum = 0.0;
    unsigned long long presentMsCount = 0;
    double startMs = 0.0;

    // D2 主统计量：Present→Present 间隔（不是 Present1 调用耗时）。
    // 上限 100k 采样 ≈ 10 分钟 @165Hz，足够覆盖 D3 长稳窗口；超出后只累积 drops。
    std::vector<double> intervalsMs;
    double prevPresentMs = 0.0;   // 上次 Present1 的时间戳
    bool hasPrevPresent = false;

    bool InitGraphics(char* errText, size_t errTextLen);
    void ReleaseGraphics();
    bool SyncSwapChainToTexture(ID3D11Texture2D* tex);
    void SnapshotFrame(ID3D11Texture2D* tex);
    void RenderAndPresent(ID3D11Texture2D* tex, ID3D11ShaderResourceView* srv);
    void WorkerMain();
};

bool HarborOsrHost::Impl::InitGraphics(char* errText, size_t errTextLen) {
    // --- DPI（**必须断言**，不是"记录一下就算") ---
    //
    // 为什么这条必须硬断言: 进程若停留在 UNAWARE，GetSystemMetrics(SM_CXSCREEN) 返回的是
    // 被系统虚拟化（除以缩放比）后的逻辑尺寸 —— 实测 1707，而物理是 2560（150% 缩放）。
    // 本 Demo 全程物理像素直传（窗口尺寸 / 交换链尺寸 / 纹理尺寸），一旦 DPI 感知级别错了，
    // 所有尺寸都会静默偏 1.5 倍，判据⑥（像素恒等）会以一种"看不出来"的方式失败。
    // 所以这里不接受"设置失败也无所谓"，要求实际感知级别一定是 PER_MONITOR(2)。
    //
    // 允许 SetProcessDpiAwarenessContext 返回 FALSE: Electron 启动时通常已经设过，
    // 重复设置会失败（ERROR_ACCESS_DENIED），但**结果**是对的。判据看结果，不看返回值。
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    const DPI_AWARENESS awareness =
        GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext());
    stats.dpiAwareness = static_cast<int>(awareness);
    if (awareness != DPI_AWARENESS_PER_MONITOR_AWARE) {
        // 无法升级到 PMv2: 说明被更早的设置钉死（例如 UNAWARE+系统虚拟化）。
        // 在 UNAWARE 下所有尺寸换算都会错，宁可判死也不要在错尺寸上跑出"看起来 PASS"的结果。
        SetErr(errText, errTextLen,
               "DPI assertion failed: awareness=%d (need PER_MONITOR=%d); "
               "all sizes would be virtualized",
               static_cast<int>(awareness), static_cast<int>(DPI_AWARENESS_PER_MONITOR_AWARE));
        return false;
    }
    // 交叉校验: PMv2 下主屏宽度必须是物理像素（>= SM_CXSCREEN 的虚拟化值）。
    // 这一步抓的是"感知级别报了 PMv2 但进程仍在虚拟化"这种不一致（少见但确实存在）。
    const int physicalWidth = GetSystemMetrics(SM_CXSCREEN);
    if (physicalWidth < cfg.width) {
        SetErr(errText, errTextLen,
               "DPI assertion failed: SM_CXSCREEN=%d < requested width=%u "
               "(screen is virtualized, sizes cannot be trusted)",
               physicalWidth, cfg.width);
        return false;
    }

    // --- 窗口 ---
    HINSTANCE instance = GetModuleHandleW(nullptr);
    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = DefWindowProcW;
    wc.hInstance = instance;
    wc.lpszClassName = kWindowClass;
    wc.hCursor = LoadCursorW(nullptr, HARBOR_IDC_ARROW);
    if (RegisterClassExW(&wc) == 0) {
        const DWORD lastErr = GetLastError();
        if (lastErr != ERROR_CLASS_ALREADY_EXISTS) {
            SetErr(errText, errTextLen, "RegisterClassExW failed err=%lu",
                   static_cast<unsigned long>(lastErr));
            return false;
        }
    }

    // WS_EX_NOREDIRECTIONBITMAP: 让 DWM 不为本窗口分配重定向表面，DComp 才能直接接管合成。
    hwnd = CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP, kWindowClass, cfg.title,
                           WS_POPUP | WS_VISIBLE, 120, 120,
                           static_cast<int>(cfg.width), static_cast<int>(cfg.height),
                           nullptr, nullptr, instance, nullptr);
    if (hwnd == nullptr) {
        SetErr(errText, errTextLen, "CreateWindowExW failed err=%lu",
               static_cast<unsigned long>(GetLastError()));
        return false;
    }
    stats.dpi = GetDpiForWindow(hwnd);
    // 置顶 + 不抢焦点，纯粹为了 Demo 现场可看见"原生窗口里是 Electron 的画面"。
    SetWindowPos(hwnd, HWND_TOP, 120, 120, static_cast<int>(cfg.width),
                 static_cast<int>(cfg.height), SWP_NOACTIVATE | SWP_SHOWWINDOW);

    // --- D3D11 设备 ---
    const D3D_FEATURE_LEVEL wantLevels[] = {D3D_FEATURE_LEVEL_11_1,
                                            D3D_FEATURE_LEVEL_11_0};
    D3D_FEATURE_LEVEL gotLevel = D3D_FEATURE_LEVEL_11_0;
    HRESULT hr = D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        wantLevels, static_cast<UINT>(sizeof(wantLevels) / sizeof(wantLevels[0])),
        D3D11_SDK_VERSION,
        &device, &gotLevel, &ctx);
    if (FAILED(hr) || device == nullptr) {
        SetErr(errText, errTextLen, "D3D11CreateDevice failed hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }
    device->QueryInterface(__uuidof(ID3D11Device1), reinterpret_cast<void**>(&device1));
    if (device1 == nullptr) {
        SetErr(errText, errTextLen, "QueryInterface(ID3D11Device1) returned null");
        return false;
    }

    // --- 交换链: 单链（全进程只有这一条） ---
    IDXGIDevice* dxgiDevice = nullptr;
    hr = device->QueryInterface(__uuidof(IDXGIDevice), reinterpret_cast<void**>(&dxgiDevice));
    if (FAILED(hr) || dxgiDevice == nullptr) {
        SetErr(errText, errTextLen, "QueryInterface(IDXGIDevice) hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }
    IDXGIAdapter* adapter = nullptr;
    hr = dxgiDevice->GetAdapter(&adapter);
    if (FAILED(hr) || adapter == nullptr) {
        dxgiDevice->Release();
        SetErr(errText, errTextLen, "IDXGIDevice::GetAdapter hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }
    IDXGIFactory2* factory = nullptr;
    hr = adapter->GetParent(__uuidof(IDXGIFactory2), reinterpret_cast<void**>(&factory));
    adapter->Release();
    dxgiDevice->Release();
    if (FAILED(hr) || factory == nullptr) {
        SetErr(errText, errTextLen, "IDXGIAdapter::GetParent(IDXGIFactory2) hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }

    DXGI_SWAP_CHAIN_DESC1 scd = {};
    scd.Width = cfg.width;
    scd.Height = cfg.height;
    scd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;  // Electron OSR 纹理是 BGRA8
    scd.Stereo = FALSE;
    scd.SampleDesc.Count = 1;
    scd.SampleDesc.Quality = 0;
    scd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    scd.BufferCount = 2;
    scd.Scaling = DXGI_SCALING_STRETCH;
    scd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    scd.AlphaMode = DXGI_ALPHA_MODE_PREMULTIPLIED;
    scd.Flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;
    hr = factory->CreateSwapChainForComposition(device, &scd, nullptr, &swapChain);
    factory->Release();
    if (FAILED(hr) || swapChain == nullptr) {
        SetErr(errText, errTextLen, "CreateSwapChainForComposition hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }
    hr = swapChain->QueryInterface(__uuidof(IDXGISwapChain2),
                                   reinterpret_cast<void**>(&swapChain2));
    if (FAILED(hr) || swapChain2 == nullptr) {
        SetErr(errText, errTextLen, "QueryInterface(IDXGISwapChain2) hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }
    hr = swapChain2->SetMaximumFrameLatency(1);
    if (FAILED(hr)) {
        SetErr(errText, errTextLen, "SetMaximumFrameLatency(1) hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }
    frameWaitable = swapChain2->GetFrameLatencyWaitableObject();
    if (frameWaitable == nullptr) {
        SetErr(errText, errTextLen, "GetFrameLatencyWaitableObject returned null");
        return false;
    }

    // --- 后缓冲 RTV ---
    ID3D11Texture2D* backBuffer = nullptr;
    hr = swapChain->GetBuffer(0, __uuidof(ID3D11Texture2D),
                              reinterpret_cast<void**>(&backBuffer));
    if (FAILED(hr) || backBuffer == nullptr) {
        SetErr(errText, errTextLen, "IDXGISwapChain::GetBuffer(0) hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }
    hr = device->CreateRenderTargetView(backBuffer, nullptr, &rtv);
    backBuffer->Release();
    if (FAILED(hr) || rtv == nullptr) {
        SetErr(errText, errTextLen, "CreateRenderTargetView hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }

    // --- 着色器（运行时 D3DCompile，避免依赖 T04 的 shaders/ 目录） ---
    ID3DBlob* vsBlob = nullptr;
    ID3DBlob* psBlob = nullptr;
    if (!CompileShader("VSMain", "vs_5_0", &vsBlob, errText, errTextLen)) return false;
    if (!CompileShader("PSMain", "ps_5_0", &psBlob, errText, errTextLen)) {
        vsBlob->Release();
        return false;
    }
    hr = device->CreateVertexShader(vsBlob->GetBufferPointer(), vsBlob->GetBufferSize(),
                                    nullptr, &vs);
    if (SUCCEEDED(hr)) {
        hr = device->CreatePixelShader(psBlob->GetBufferPointer(), psBlob->GetBufferSize(),
                                       nullptr, &ps);
    }
    vsBlob->Release();
    psBlob->Release();
    if (FAILED(hr) || vs == nullptr || ps == nullptr) {
        SetErr(errText, errTextLen, "CreateVertexShader/CreatePixelShader hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }

    D3D11_SAMPLER_DESC sd = {};
    sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sd.AddressU = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.AddressV = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.ComparisonFunc = D3D11_COMPARISON_NEVER;
    sd.MinLOD = 0.0f;
    sd.MaxLOD = D3D11_FLOAT32_MAX;
    hr = device->CreateSamplerState(&sd, &sampler);
    if (FAILED(hr) || sampler == nullptr) {
        SetErr(errText, errTextLen, "CreateSamplerState hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }

    // --- DComp: CreateTargetForHwnd + CreateVisual + SetContent + SetRoot + Commit ---
    hr = DCompositionCreateDevice(nullptr, __uuidof(IDCompositionDevice),
                                  reinterpret_cast<void**>(&dcomp));
    if (FAILED(hr) || dcomp == nullptr) {
        // 回退到用 DXGI 设备建 DComp 设备（部分驱动只接受这条路径）。
        hr = DCompositionCreateDevice2(device, __uuidof(IDCompositionDevice),
                                       reinterpret_cast<void**>(&dcomp));
    }
    if (FAILED(hr) || dcomp == nullptr) {
        SetErr(errText, errTextLen, "DCompositionCreateDevice hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }
    hr = dcomp->CreateTargetForHwnd(hwnd, TRUE, &dcompTarget);
    if (FAILED(hr) || dcompTarget == nullptr) {
        SetErr(errText, errTextLen, "IDCompositionDevice::CreateTargetForHwnd hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }
    hr = dcomp->CreateVisual(&dcompVisual);
    if (FAILED(hr) || dcompVisual == nullptr) {
        SetErr(errText, errTextLen, "IDCompositionDevice::CreateVisual hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }
    hr = dcompVisual->SetContent(swapChain);
    if (FAILED(hr)) {
        SetErr(errText, errTextLen, "IDCompositionVisual::SetContent hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }
    hr = dcompTarget->SetRoot(dcompVisual);
    if (FAILED(hr)) {
        SetErr(errText, errTextLen, "IDCompositionTarget::SetRoot hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }
    hr = dcomp->Commit();
    if (FAILED(hr)) {
        SetErr(errText, errTextLen, "IDCompositionDevice::Commit hr=0x%08X",
               static_cast<unsigned int>(hr));
        return false;
    }

    stats.width = cfg.width;
    stats.height = cfg.height;
    return true;
}

void HarborOsrHost::Impl::ReleaseGraphics() {
    // 顺序敏感: 先摘 DComp 引用，再放交换链，最后销窗；
    // flip-model 交换链必须在 HWND 销毁之前释放，否则 DWM 侧可能残留引用导致退出卡顿。
    if (dcompVisual != nullptr) {
        dcompVisual->SetContent(nullptr);
        dcompVisual->Release();
        dcompVisual = nullptr;
    }
    if (dcompTarget != nullptr) {
        dcompTarget->Release();
        dcompTarget = nullptr;
    }
    if (dcomp != nullptr) {
        dcomp->Release();
        dcomp = nullptr;
    }
    if (rtv != nullptr) {
        rtv->Release();
        rtv = nullptr;
    }
    if (sampler != nullptr) {
        sampler->Release();
        sampler = nullptr;
    }
    if (ps != nullptr) {
        ps->Release();
        ps = nullptr;
    }
    if (vs != nullptr) {
        vs->Release();
        vs = nullptr;
    }
    if (swapChain2 != nullptr) {
        swapChain2->Release();
        swapChain2 = nullptr;
    }
    if (swapChain != nullptr) {
        swapChain->Release();
        swapChain = nullptr;
    }
    if (frameWaitable != nullptr) {
        // 这个句柄由交换链持有，调用方 CloseHandle 一次即可。
        CloseHandle(frameWaitable);
        frameWaitable = nullptr;
    }
    if (ctx != nullptr) {
        ctx->ClearState();
        ctx->Flush();
        ctx->Release();
        ctx = nullptr;
    }
    if (device1 != nullptr) {
        device1->Release();
        device1 = nullptr;
    }
    if (device != nullptr) {
        device->Release();
        device = nullptr;
    }
    if (hwnd != nullptr) {
        DestroyWindow(hwnd);
        hwnd = nullptr;
        UnregisterClassW(kWindowClass, GetModuleHandleW(nullptr));
    }
}

// 首帧尺寸对齐。
//
// 【为什么必须有这一步】Electron 45 的 OSR 共享纹理不是恰好等于窗口客户区尺寸:
// 实测 BrowserWindow 640x400 -> textureInfo.codedSize = 640x402（Chromium 补了 2px 对齐）。
// 若交换链固定建 640x400，blit 会做一次 400/402 的纵向缩放 —— 画面能用，但不是像素精确，
// 文字边缘会有 0.5% 的采样模糊。正确做法是**按真实纹理尺寸重建交换链**，一次，之后不再变。
//
// 只在渲染线程调用（ResizeBuffers 要求释放全部后缓冲引用，且必须与 Present 同线程）。
bool HarborOsrHost::Impl::SyncSwapChainToTexture(ID3D11Texture2D* tex) {
    if (tex == nullptr || swapChain == nullptr) return false;
    D3D11_TEXTURE2D_DESC texDesc = {};
    tex->GetDesc(&texDesc);
    if (texDesc.Width == 0 || texDesc.Height == 0) return false;
    if (texDesc.Width == cfg.width && texDesc.Height == cfg.height) return true;

    // 1) 释放后缓冲视图 —— ResizeBuffers 的前提
    if (rtv != nullptr) {
        ctx->OMSetRenderTargets(0, nullptr, nullptr);
        rtv->Release();
        rtv = nullptr;
    }
    // 2) 重建后缓冲。FRAME_LATENCY_WAITABLE_OBJECT 必须原样保留，否则帧延迟等待对象失效。
    HRESULT hr = swapChain->ResizeBuffers(
        /*BufferCount=*/2, texDesc.Width, texDesc.Height, DXGI_FORMAT_B8G8R8A8_UNORM,
        DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT);
    if (FAILED(hr)) return false;

    // 3) 重建 RTV
    ID3D11Texture2D* backBuffer = nullptr;
    hr = swapChain->GetBuffer(0, __uuidof(ID3D11Texture2D),
                              reinterpret_cast<void**>(&backBuffer));
    if (FAILED(hr) || backBuffer == nullptr) return false;
    hr = device->CreateRenderTargetView(backBuffer, nullptr, &rtv);
    backBuffer->Release();
    if (FAILED(hr) || rtv == nullptr) return false;

    // 4) 窗口同步改成同样尺寸，保证"屏幕上的一个像素 == 纹理的一个像素"
    cfg.width = texDesc.Width;
    cfg.height = texDesc.Height;
    if (hwnd != nullptr) {
        SetWindowPos(hwnd, nullptr, 0, 0, static_cast<int>(cfg.width),
                     static_cast<int>(cfg.height), SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
    {
        std::lock_guard<std::mutex> lock(mu);
        stats.width = cfg.width;
        stats.height = cfg.height;
    }
    return true;
}

// 把共享纹理拷进宿主私有纹理（内容此后不再被 Chromium 纹理池改写）。
void HarborOsrHost::Impl::SnapshotFrame(ID3D11Texture2D* tex) {
    if (tex == nullptr || device == nullptr || ctx == nullptr) return;
    D3D11_TEXTURE2D_DESC desc = {};
    tex->GetDesc(&desc);

    // 尺寸/格式变了就重建私有纹理（正常情况只发生一次）。
    if (snapshotTex == nullptr || desc.Width != snapshotWidth ||
        desc.Height != snapshotHeight || desc.Format != snapshotFormat) {
        if (snapshotTex != nullptr) {
            snapshotTex->Release();
            snapshotTex = nullptr;
        }
        D3D11_TEXTURE2D_DESC sd = desc;
        sd.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        sd.MiscFlags = 0;
        sd.Usage = D3D11_USAGE_DEFAULT;
        sd.CPUAccessFlags = 0;
        sd.MipLevels = 1;
        sd.ArraySize = 1;
        if (FAILED(device->CreateTexture2D(&sd, nullptr, &snapshotTex)) ||
            snapshotTex == nullptr) {
            snapshotTex = nullptr;
            return;
        }
        snapshotWidth = desc.Width;
        snapshotHeight = desc.Height;
        snapshotFormat = desc.Format;
    }
    ctx->CopyResource(snapshotTex, tex);
}

void HarborOsrHost::Impl::RenderAndPresent(ID3D11Texture2D* tex,
                                           ID3D11ShaderResourceView* srv) {
    if (tex == nullptr || srv == nullptr || ctx == nullptr || swapChain == nullptr) return;

    // 首帧对齐真实纹理尺寸（只做一次）。失败也不致命: 继续按原尺寸缩放 output。
    if (!sizeSynced) {
        sizeSynced = true;
        if (!SyncSwapChainToTexture(tex)) {
            // 注意: 不算 presentFailed —— 那是判据⑤的口径，只统计真正的 Present1 失败。
            // 尺寸对齐失败会退化成缩放输出（画面仍正确，只是非像素精确），单独记。
            std::lock_guard<std::mutex> lock(mu);
            stats.resizeFailed += 1;
        }
    }

    // 帧延迟等待对象: SetMaximumFrameLatency(1) 后，这里保证最多 1 帧在飞，
    // 否则 60fps 输入 + 165Hz vsync 会在队列里堆帧，实测表现为延迟线性增长。
    if (frameWaitable != nullptr) {
        const DWORD waitResult = WaitForSingleObject(frameWaitable, 100);
        if (waitResult == WAIT_TIMEOUT) {
            std::lock_guard<std::mutex> lock(mu);
            stats.waitTimeouts += 1;
        }
    }

    D3D11_VIEWPORT viewport = {};
    viewport.TopLeftX = 0.0f;
    viewport.TopLeftY = 0.0f;
    viewport.Width = static_cast<float>(cfg.width);
    viewport.Height = static_cast<float>(cfg.height);
    viewport.MinDepth = 0.0f;
    viewport.MaxDepth = 1.0f;

    ctx->OMSetRenderTargets(1, &rtv, nullptr);
    ctx->RSSetViewports(1, &viewport);
    ctx->IASetInputLayout(nullptr);
    ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ctx->VSSetShader(vs, nullptr, 0);
    ctx->PSSetShader(ps, nullptr, 0);
    ctx->PSSetShaderResources(0, 1, &srv);
    ctx->PSSetSamplers(0, 1, &sampler);
    ctx->Draw(3, 0);

    ID3D11ShaderResourceView* nullSrv[1] = {nullptr};
    ctx->PSSetShaderResources(0, 1, nullSrv);

    // SyncInterval 必须是 1: Present1(0,…) 不等 vsync，帧间隔只有 0.15ms 级，
    // 结果是把 GPU 打满而画面节奏失控；Present1(1,…) 才会被钉在刷新率上（165Hz 实测 6.0594ms）。
    DXGI_PRESENT_PARAMETERS presentParams = {};
    const double presentBeginMs = NowMs();
    const HRESULT presentHr = swapChain->Present1(1, 0, &presentParams);
    const double presentMs = NowMs() - presentBeginMs;

    std::lock_guard<std::mutex> lock(mu);
    stats.rendered += 1;
    stats.lastPresentHr = static_cast<unsigned long long>(static_cast<unsigned int>(presentHr));
    stats.lastPresentMs = presentMs;
    presentMsSum += presentMs;
    presentMsCount += 1;
    stats.avgPresentMs = presentMsSum / static_cast<double>(presentMsCount);
    if (presentMs > stats.maxPresentMs) stats.maxPresentMs = presentMs;

    // Present→Present 间隔：在锁内取时间戳，保证与 presented 计数同一因果顺序。
    {
      const double nowMs = NowMs();
      if (hasPrevPresent) {
        const double gap = nowMs - prevPresentMs;
        // 剔除首帧/冷启导致的异常大间隔（> 200ms 视为 stall，单独不计数，
        // 否则一个 stall 会把 p99 拉到无意义的量级）。
        if (gap > 0.0 && gap < 200.0 && intervalsMs.size() < 100000) {
          intervalsMs.push_back(gap);
        }
      }
      prevPresentMs = nowMs;
      hasPrevPresent = true;
    }
    if (SUCCEEDED(presentHr)) {
        stats.presented += 1;
    } else {
        stats.presentFailed += 1;
        if (presentHr == DXGI_ERROR_DEVICE_REMOVED || presentHr == DXGI_ERROR_DEVICE_RESET) {
            stop = true;
        }
    }
}

void HarborOsrHost::Impl::WorkerMain() {
    char err[512] = {0};
    const bool ok = InitGraphics(err, sizeof(err));
    {
        std::lock_guard<std::mutex> lock(mu);
        initDone = true;
        initOk = ok;
        ready = ok;
        if (!ok) {
            std::snprintf(initErr, sizeof(initErr), "%s", err);
        }
        startMs = NowMs();
    }
    cv.notify_all();
    if (!ok) return;

    MSG msg = {};
    while (true) {
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) stop = true;
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if (stop) break;

        ID3D11Texture2D* tex = nullptr;
        ID3D11ShaderResourceView* srv = nullptr;
        {
            std::unique_lock<std::mutex> lock(mu);
            // 短超时轮询: 一边等帧，一边保持消息泵（窗口创建在本线程，消息只能本线程取）。
            cv.wait_for(lock, std::chrono::milliseconds(8),
                        [this] { return stop || hasFrame; });
            if (stop && !hasFrame) break;
            if (hasFrame) {
                tex = slotTex;
                srv = slotSrv;
                slotTex = nullptr;
                slotSrv = nullptr;
                hasFrame = false;
            }
        }
        if (tex != nullptr) {
            // 暂停期间不消费帧: 保留帧要停在"屏幕上正在显示的那一帧"，
            // 否则刚比对的纹理和刚落屏的画面不是同一帧。
            if (paused.load()) {
                // 暂停期间不再取帧渲染 —— 屏幕已定格在最后一次 Present 的画面上。
                // 快照也不需要更新（它已经是那一帧的副本）。
                ReleaseSharedTexture(tex, srv);
                continue;
            }
            RenderAndPresent(tex, srv);

            if (retainLastFrame.load()) {
                // 快照这一帧到宿主私有纹理，并**立刻 Flush**。
                //
                // 【为什么必须 Flush】CopyResource 只是把拷贝命令排进 GPU 队列（异步）。
                // 如果不 Flush 就 ReleaseSharedTexture，Chromium 的纹理池会马上把这块
                // 共享显存复用于下一帧，GPU 真正执行拷贝时读到的已经是新内容 ——
                // 这就是那个"matchRatio 偶发掉到 0.95、中心像素 tex=背景/screen=卡片"的根因。
                // 在仍持有该帧引用时 Flush，拷贝一定读的是这一帧本身。
                SnapshotFrame(tex);
                ctx->Flush();
            }
            // 采样完就放引用: 本进程不再持有这块共享显存，Electron 侧可以放心回收。
            // 注意这里不能在别的线程拿 ctx 去 Flush（ctx 由本线程独占），
            // 退出路径的 Flush 在 ReleaseGraphics() 里做。
            ReleaseSharedTexture(tex, srv);
        }
    }

    // 清理快照纹理（窗口线程已退出，无竞争）
    if (snapshotTex != nullptr) {
        snapshotTex->Release();
        snapshotTex = nullptr;
    }

    // 清理残留帧
    {
        std::lock_guard<std::mutex> lock(mu);
        if (slotSrv != nullptr) {
            slotSrv->Release();
            slotSrv = nullptr;
        }
        if (slotTex != nullptr) {
            slotTex->Release();
            slotTex = nullptr;
        }
        hasFrame = false;
        ready = false;
    }
    ReleaseGraphics();
}

// ---------------------------------------------------------------------------
// HarborOsrHost
// ---------------------------------------------------------------------------
HarborOsrHost::HarborOsrHost() : impl_(new Impl()) {}

HarborOsrHost::~HarborOsrHost() {
    Shutdown();
    delete impl_;
    impl_ = nullptr;
}

bool HarborOsrHost::Init(const HarborOsrHostConfig& config, char* errText,
                         size_t errTextLen) {
    if (impl_ == nullptr) {
        SetErr(errText, errTextLen, "host not allocated");
        return false;
    }
    if (config.width == 0 || config.height == 0) {
        SetErr(errText, errTextLen, "bad size %ux%u", config.width, config.height);
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(impl_->mu);
        impl_->cfg = config;
        impl_->initDone = false;
        impl_->initOk = false;
        impl_->stop = false;
    }
    impl_->worker = std::thread([this] { impl_->WorkerMain(); });

    std::unique_lock<std::mutex> lock(impl_->mu);
    const bool signalled = impl_->cv.wait_for(lock, std::chrono::seconds(15),
                                              [this] { return impl_->initDone; });
    if (!signalled) {
        SetErr(errText, errTextLen, "host init timeout (15s)");
        return false;
    }
    if (!impl_->initOk) {
        SetErr(errText, errTextLen, "%s", impl_->initErr[0] != '\0' ? impl_->initErr
                                                                   : "init failed");
        return false;
    }
    return true;
}

bool HarborOsrHost::IsReady() const {
    if (impl_ == nullptr) return false;
    std::lock_guard<std::mutex> lock(impl_->mu);
    return impl_->ready;
}

bool HarborOsrHost::SubmitSharedTexture(HANDLE ntHandle, HRESULT* outOpenHr) {
    if (outOpenHr != nullptr) *outOpenHr = E_FAIL;
    if (impl_ == nullptr) return false;
    if (!IsReady()) return false;

    ID3D11Texture2D* tex = nullptr;
    ID3D11ShaderResourceView* srv = nullptr;
    const HRESULT hr = OpenSharedTexture(impl_->device1, ntHandle, &tex, &srv);
    if (outOpenHr != nullptr) *outOpenHr = hr;

    std::lock_guard<std::mutex> lock(impl_->mu);
    impl_->stats.submitted += 1;
    impl_->stats.lastOpenHr =
        static_cast<unsigned long long>(static_cast<unsigned int>(hr));
    if (FAILED(hr) || tex == nullptr || srv == nullptr) {
        impl_->stats.openFail += 1;
        return false;
    }
    impl_->stats.openOk += 1;
    if (impl_->hasFrame) {
        // 上一帧还没被渲染线程取走 —— 直接丢弃旧的，只保留最新（低延迟优先）。
        ReleaseSharedTexture(impl_->slotTex, impl_->slotSrv);
        impl_->stats.dropped += 1;
    }
    impl_->slotTex = tex;
    impl_->slotSrv = srv;
    impl_->hasFrame = true;
    impl_->slotSeq += 1;
    impl_->cv.notify_one();
    return true;
}

void HarborOsrHost::GetStats(HarborOsrHostStats* out) const {
    if (out == nullptr || impl_ == nullptr) return;
    std::lock_guard<std::mutex> lock(impl_->mu);
    *out = impl_->stats;
    if (impl_->startMs > 0.0) {
        out->lifeMs = NowMs() - impl_->startMs;
    }
    out->ready = impl_->ready ? 1 : 0;

    // ---- D2 主统计量：从原始间隔算分布 ----
    // 为什么在 GetStats 里算而不是每帧增量维护：百分位需要全样本排序，
    // 增量估算（如 P² 算法）在小样本上会偏离真值，而这里样本量只有几千，
    // 排序成本可忽略。代价是 GetStats 不能是纯 const —— 故用局部副本排序。
    const size_t nSam = impl_->intervalsMs.size();
    out->intervalSamples = static_cast<unsigned long long>(nSam);
    if (nSam == 0) {
        out->intervalP50Ms = out->intervalP95Ms = out->intervalP99Ms = 0.0;
        out->intervalMaxMs = out->intervalMinMs = 0.0;
        out->drops = 0;
        out->dropRate = 0.0;
        return;
    }

    std::vector<double> sorted(impl_->intervalsMs);
    std::sort(sorted.begin(), sorted.end());
    auto pct = [&sorted](double p) {
        const double k = p * static_cast<double>(sorted.size() - 1);
        const size_t lo = static_cast<size_t>(k);
        const size_t hi = (lo + 1 < sorted.size()) ? lo + 1 : lo;
        const double frac = k - static_cast<double>(lo);
        return sorted[lo] * (1.0 - frac) + sorted[hi] * frac;
    };

    out->intervalP50Ms = pct(0.50);
    out->intervalP95Ms = pct(0.95);
    out->intervalP99Ms = pct(0.99);
    out->intervalMinMs = sorted.front();
    out->intervalMaxMs = sorted.back();

    // 掉拍基准 = 实测中位数（PRD D2② 明令：不用理论 1/hz）。
    // 阈值 1.5×：drops 定义为「间隔 >= 2 个节拍」的保守解释 —— 因为 2× 严格阈值
    // 会漏掉 1.7 拍的早期掉帧，而 1.5× 仍能排除正常的 vsync 抖动（实测 p99/p50 ≈ 1.06）。
    unsigned long long drops = 0;
    if (out->intervalP50Ms > 0.0) {
        const double threshold = out->intervalP50Ms * 1.5;
        for (double v : sorted) {
            if (v >= threshold) ++drops;
        }
    }
    out->drops = drops;
    out->dropRate = static_cast<double>(drops) / static_cast<double>(nSam);
}

void HarborOsrHost::RetainLastFrame(bool retain) {
    if (impl_ == nullptr) return;
    impl_->retainLastFrame.store(retain);
}

bool HarborOsrHost::GetRetainedFrame(ID3D11Texture2D** outTex, ID3D11Device** outDevice,
                                     ID3D11DeviceContext** outCtx) const {
    if (impl_ == nullptr) return false;
    if (outTex != nullptr) *outTex = impl_->snapshotTex;
    if (outDevice != nullptr) *outDevice = impl_->device;
    if (outCtx != nullptr) *outCtx = impl_->ctx;
    return impl_->snapshotTex != nullptr;
}

bool HarborOsrHost::ResnapshotLastFrame() {
    // 【已废弃为 no-op】不要试图"事后重新快照共享纹理"。
    //
    // 原因: 一旦我们 Release 了 OpenSharedResource1 的引用，Chromium 纹理池会立刻把这块
    // 显存分配给后续帧。此时无论我们手里还留没留 AddRef，纹理**内容**都已经变了
    // （引用管的是生命周期，不是内容所有权）。实测: 这条路径会让 matchRatio 在
    // 0.95~1.00 之间随机跳，中心像素恒为 tex=背景 / screen=卡片。
    // 正确做法只有一个: 在持有该帧引用的**当帧**里 CopyResource + Flush（见 WorkerMain）。
    // 保留这个函数只为不破坏 JS 侧调用形态，返回值反映"快照是否存在"。
    if (impl_ == nullptr) return false;
    return impl_->snapshotTex != nullptr;
}

void HarborOsrHost::PauseRendering(bool paused) {
    if (impl_ == nullptr) return;
    impl_->paused.store(paused);
}

HRESULT HarborOsrHost::ReadCenterPixelOfTexture(ID3D11Texture2D* tex, char* outBgra,
                                                size_t outBgraLen) {
    if (impl_ == nullptr || tex == nullptr || impl_->device == nullptr ||
        impl_->ctx == nullptr) {
        return E_POINTER;
    }
    return harbor::osr::ReadCenterPixelBGRA(impl_->device, impl_->ctx, tex, outBgra,
                                            outBgraLen);
}

void HarborOsrHost::ReleaseRetainedFrame() {
    if (impl_ == nullptr) return;
    // 先关开关再放纹理: 否则渲染线程可能正在往里拷。
    impl_->retainLastFrame.store(false);
    // 等一帧轮转（8ms 轮询周期，40ms 足够几轮）。
    Sleep(40);
    ID3D11Texture2D* tex = impl_->snapshotTex;
    impl_->snapshotTex = nullptr;
    if (tex != nullptr) tex->Release();
}

void* HarborOsrHost::WindowHandle() const {
    if (impl_ == nullptr) return nullptr;
    std::lock_guard<std::mutex> lock(impl_->mu);
    return impl_->ready ? reinterpret_cast<void*>(impl_->hwnd) : nullptr;
}

double HarborOsrHost::Shutdown() {
    if (impl_ == nullptr) return 0.0;
    const double beginMs = NowMs();
    {
        std::lock_guard<std::mutex> lock(impl_->mu);
        impl_->stop = true;
    }
    impl_->cv.notify_all();
    if (impl_->worker.joinable()) {
        impl_->worker.join();
    }
    return NowMs() - beginMs;
}

}  // namespace osr
}  // namespace harbor
