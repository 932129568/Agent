// addon/addon.cpp -- 通路 B 的 N-API 桥
//
// 编译硬约束（踩过坑，勿改）:
//   1) 必须用 node-gyp 编（--runtime=electron --target=<ver>），**不能**手工 cl。
//      手工 cl 编出的 .node 在 Electron 里加载时静默崩溃（连最小 addon 都崩、无报错、
//      process.exit 都不执行），根因是缺 win_delay_load_hook.cc 的延迟加载钩子。
//   2) binding.gyp 必须含 /utf-8。否则 MSVC 按 GBK 解析本文件的中文注释，
//      汉字尾字节 0x5C（'\'）会吞掉下一行，表现为假的 "C2065: srv 未声明"。
//
// 导出:
//   openSharedTexture(ntHandleBuffer, width, height) -> { ok, hr, openHr, srvHr, mapHr,
//                                                          centerPixelBGRA, width, height }
//   hostInit(width, height, title)  -> { ok, error, dpiAwareness }
//   hostPresent(ntHandleBuffer)     -> { ok, openHr, handleValue }
//   hostStats()                     -> 宿主侧统计
//   hostShutdown()                  -> { ok, shutdownMs }

#include <windows.h>

#include <d3d11_1.h>
#include <node_api.h>

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <unordered_set>
#include <vector>

#include "osr_bridge.h"
#include "osr_host.h"

namespace {

using harbor::osr::HarborOsrHost;
using harbor::osr::HarborOsrHostConfig;
using harbor::osr::HarborOsrHostStats;

HarborOsrHost* g_host = nullptr;

// 探针专用设备（与宿主设备分开，避免探针把宿主的后缓冲状态搅乱）。
ID3D11Device* g_probeDevice = nullptr;
ID3D11DeviceContext* g_probeCtx = nullptr;
ID3D11Device1* g_probeDevice1 = nullptr;

napi_value MakeObject(napi_env env) {
    napi_value obj = nullptr;
    napi_create_object(env, &obj);
    return obj;
}

void SetNumber(napi_env env, napi_value obj, const char* key, double value) {
    napi_value v = nullptr;
    napi_create_double(env, value, &v);
    napi_set_named_property(env, obj, key, v);
}

void SetString(napi_env env, napi_value obj, const char* key, const char* value) {
    napi_value v = nullptr;
    napi_create_string_utf8(env, value != nullptr ? value : "", NAPI_AUTO_LENGTH, &v);
    napi_set_named_property(env, obj, key, v);
}

// HRESULT 同时给数值和 0x 十六进制，报告里两种都能直接引用。
void SetHr(napi_env env, napi_value obj, const char* key, const char* hexKey,
           HRESULT hr) {
    SetNumber(env, obj, key, static_cast<double>(static_cast<int32_t>(hr)));
    char hex[16] = {0};
    std::snprintf(hex, sizeof(hex), "0x%08X", static_cast<unsigned int>(hr));
    SetString(env, obj, hexKey, hex);
}

bool GetHandleBuffer(napi_env env, napi_value value, HANDLE* outHandle, size_t* outLen) {
    bool isBuffer = false;
    if (napi_is_buffer(env, value, &isBuffer) != napi_ok || !isBuffer) return false;
    void* data = nullptr;
    size_t len = 0;
    if (napi_get_buffer_info(env, value, &data, &len) != napi_ok) return false;
    if (data == nullptr || len < sizeof(HANDLE)) return false;
    HANDLE handle = nullptr;
    std::memcpy(&handle, data, sizeof(HANDLE));
    if (outHandle != nullptr) *outHandle = handle;
    if (outLen != nullptr) *outLen = len;
    return true;
}

bool EnsureProbeDevice() {
    if (g_probeDevice1 != nullptr) return true;
    const D3D_FEATURE_LEVEL wantLevels[] = {D3D_FEATURE_LEVEL_11_1,
                                            D3D_FEATURE_LEVEL_11_0};
    D3D_FEATURE_LEVEL gotLevel = D3D_FEATURE_LEVEL_11_0;
    HRESULT hr = D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        wantLevels, static_cast<UINT>(sizeof(wantLevels) / sizeof(wantLevels[0])),
        D3D11_SDK_VERSION, &g_probeDevice, &gotLevel, &g_probeCtx);
    if (FAILED(hr) || g_probeDevice == nullptr) return false;
    hr = g_probeDevice->QueryInterface(__uuidof(ID3D11Device1),
                                       reinterpret_cast<void**>(&g_probeDevice1));
    return SUCCEEDED(hr) && g_probeDevice1 != nullptr;
}

// openSharedTexture(ntHandleBuffer, width, height)
napi_value OpenSharedTextureJs(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3] = {nullptr, nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

    napi_value result = MakeObject(env);
    HANDLE ntHandle = nullptr;
    size_t handleBytes = 0;
    if (argc < 1 || !GetHandleBuffer(env, argv[0], &ntHandle, &handleBytes)) {
        SetNumber(env, result, "ok", 0);
        SetString(env, result, "error", "bad handle buffer (need Buffer with 8-byte HANDLE)");
        SetHr(env, result, "hr", "hrHex", E_INVALIDARG);
        return result;
    }
    SetNumber(env, result, "ok", 0);
    SetNumber(env, result, "handleBytes", static_cast<double>(handleBytes));
    char handleText[32] = {0};
    std::snprintf(handleText, sizeof(handleText), "%llu",
                  static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(ntHandle)));
    SetString(env, result, "handleValue", handleText);

    if (!EnsureProbeDevice()) {
        SetString(env, result, "error", "D3D11CreateDevice(ID3D11Device1) failed");
        SetHr(env, result, "hr", "hrHex", E_FAIL);
        return result;
    }

    ID3D11Texture2D* tex = nullptr;
    ID3D11ShaderResourceView* srv = nullptr;
    const HRESULT hr = harbor::osr::OpenSharedTexture(g_probeDevice1, ntHandle, &tex, &srv);
    const harbor::osr::OpenSharedTextureDiagnostics diag =
        harbor::osr::GetLastOpenSharedTextureDiagnostics();
    SetHr(env, result, "hr", "hrHex", hr);
    SetHr(env, result, "openHr", "openHrHex", diag.openHr);
    SetHr(env, result, "srvHr", "srvHrHex", diag.srvHr);
    if (FAILED(hr) || tex == nullptr || srv == nullptr) {
        SetNumber(env, result, "ok", 0);
        return result;
    }

    harbor::osr::SharedTextureView view;
    harbor::osr::DescribeSharedTexture(tex, &view);
    SetNumber(env, result, "width", static_cast<double>(view.width));
    SetNumber(env, result, "height", static_cast<double>(view.height));
    SetNumber(env, result, "format", static_cast<double>(view.format));

    // 取证: 中心像素（这条路径故意做一次 CPU 回读，**仅用于断言**，合成路径不走它）
    char pixel[48] = {0};
    const HRESULT mapHr =
        harbor::osr::ReadCenterPixelBGRA(g_probeDevice, g_probeCtx, tex, pixel, sizeof(pixel));
    SetHr(env, result, "mapHr", "mapHrHex", mapHr);
    SetString(env, result, "centerPixelBGRA", pixel);

    // 显式解绑 + Flush + 成对释放: 证明"释放后立刻还能干活、不会卡在 GPU 同步上"。
    harbor::osr::FlushAndReleaseSharedTexture(g_probeCtx, tex, srv);
    SetNumber(env, result, "ok", 1);
    SetNumber(env, result, "released", 1);
    return result;
}

// hostInit(width, height, title)
napi_value HostInitJs(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3] = {nullptr, nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

    napi_value result = MakeObject(env);
    HarborOsrHostConfig config;
    if (argc >= 1) {
        int32_t w = 0;
        if (napi_get_value_int32(env, argv[0], &w) == napi_ok && w > 0) {
            config.width = static_cast<UINT>(w);
        }
    }
    if (argc >= 2) {
        int32_t h = 0;
        if (napi_get_value_int32(env, argv[1], &h) == napi_ok && h > 0) {
            config.height = static_cast<UINT>(h);
        }
    }
    // N-API 的 utf16 接口用 char16_t*，而 Win32 用 wchar_t*。
    // Windows 上 sizeof(wchar_t) == 2，逐字节等价，用 memcpy 显式转换（不能直接强转指针）。
    static_assert(sizeof(wchar_t) == sizeof(char16_t), "Windows wchar_t must be 16-bit");
    wchar_t title[256] = {0};
    if (argc >= 3) {
        char16_t title16[256] = {0};
        size_t copied = 0;
        if (napi_get_value_string_utf16(env, argv[2], title16, 255, &copied) == napi_ok) {
            std::memcpy(title, title16, sizeof(wchar_t) * (copied + 1));
        }
    }
    if (title[0] != L'\0') config.title = title;

    if (g_host != nullptr) {
        g_host->Shutdown();
        delete g_host;
        g_host = nullptr;
    }
    g_host = new HarborOsrHost();
    char err[512] = {0};
    const bool ok = g_host->Init(config, err, sizeof(err));
    SetNumber(env, result, "ok", ok ? 1 : 0);
    SetString(env, result, "error", err);
    SetNumber(env, result, "width", static_cast<double>(config.width));
    SetNumber(env, result, "height", static_cast<double>(config.height));
    HarborOsrHostStats stats;
    g_host->GetStats(&stats);
    SetNumber(env, result, "dpi", static_cast<double>(stats.dpi));
    SetNumber(env, result, "dpiAwareness", static_cast<double>(stats.dpiAwareness));
    SetNumber(env, result, "ready", static_cast<double>(stats.ready));
    return result;
}

// hostPresent(ntHandleBuffer)
napi_value HostPresentJs(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

    napi_value result = MakeObject(env);
    HANDLE ntHandle = nullptr;
    if (argc < 1 || !GetHandleBuffer(env, argv[0], &ntHandle, nullptr)) {
        SetNumber(env, result, "queued", 0);
        SetString(env, result, "error", "bad handle buffer");
        SetHr(env, result, "openHr", "openHrHex", E_INVALIDARG);
        return result;
    }
    char handleText[32] = {0};
    std::snprintf(handleText, sizeof(handleText), "%llu",
                  static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(ntHandle)));
    SetString(env, result, "handleValue", handleText);

    if (g_host == nullptr) {
        SetNumber(env, result, "queued", 0);
        SetString(env, result, "error", "host not init");
        SetHr(env, result, "openHr", "openHrHex", E_UNEXPECTED);
        return result;
    }
    HRESULT openHr = E_FAIL;
    const bool queued = g_host->SubmitSharedTexture(ntHandle, &openHr);
    SetNumber(env, result, "queued", queued ? 1 : 0);
    SetHr(env, result, "openHr", "openHrHex", openHr);
    return result;
}

// hostStats()
napi_value HostStatsJs(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = MakeObject(env);
    if (g_host == nullptr) {
        SetNumber(env, result, "ready", 0);
        return result;
    }
    HarborOsrHostStats stats;
    g_host->GetStats(&stats);
    SetNumber(env, result, "submitted", static_cast<double>(stats.submitted));
    SetNumber(env, result, "openOk", static_cast<double>(stats.openOk));
    SetNumber(env, result, "openFail", static_cast<double>(stats.openFail));
    SetNumber(env, result, "dropped", static_cast<double>(stats.dropped));
    SetNumber(env, result, "rendered", static_cast<double>(stats.rendered));
    SetNumber(env, result, "presented", static_cast<double>(stats.presented));
    SetNumber(env, result, "presentFailed", static_cast<double>(stats.presentFailed));
    SetNumber(env, result, "waitTimeouts", static_cast<double>(stats.waitTimeouts));
    SetNumber(env, result, "resizeFailed", static_cast<double>(stats.resizeFailed));
    SetHr(env, result, "lastOpenHr", "lastOpenHrHex",
          static_cast<HRESULT>(static_cast<unsigned int>(stats.lastOpenHr)));
    SetHr(env, result, "lastPresentHr", "lastPresentHrHex",
          static_cast<HRESULT>(static_cast<unsigned int>(stats.lastPresentHr)));
    SetNumber(env, result, "lastPresentMs", stats.lastPresentMs);
    SetNumber(env, result, "avgPresentMs", stats.avgPresentMs);
    SetNumber(env, result, "maxPresentMs", stats.maxPresentMs);
    // D2 主统计量：Present→Present 间隔分布。avgPresentMs 是 Present1 调用耗时，
    // 与本组字段不是同一个量（元规则第五条），两者不可互相替代。
    SetNumber(env, result, "intervalP50Ms", stats.intervalP50Ms);
    SetNumber(env, result, "intervalP95Ms", stats.intervalP95Ms);
    SetNumber(env, result, "intervalP99Ms", stats.intervalP99Ms);
    SetNumber(env, result, "intervalMinMs", stats.intervalMinMs);
    SetNumber(env, result, "intervalMaxMs", stats.intervalMaxMs);
    SetNumber(env, result, "intervalSamples", static_cast<double>(stats.intervalSamples));
    SetNumber(env, result, "drops", static_cast<double>(stats.drops));
    SetNumber(env, result, "dropRate", stats.dropRate);
    SetNumber(env, result, "lifeMs", stats.lifeMs);
    SetNumber(env, result, "width", static_cast<double>(stats.width));
    SetNumber(env, result, "height", static_cast<double>(stats.height));
    SetNumber(env, result, "dpi", static_cast<double>(stats.dpi));
    SetNumber(env, result, "dpiAwareness", static_cast<double>(stats.dpiAwareness));
    SetNumber(env, result, "ready", static_cast<double>(stats.ready));
    return result;
}

// retainLastFrame(retain) —— 让宿主保留最后一帧纹理（供像素恒等比对）。
napi_value RetainLastFrameJs(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = MakeObject(env);
    if (g_host == nullptr) {
        SetNumber(env, result, "ok", 0);
        SetString(env, result, "error", "host not init");
        return result;
    }
    g_host->RetainLastFrame(true);
    SetNumber(env, result, "ok", 1);
    return result;
}

// pauseRendering(paused) —— 暂停/恢复宿主的出帧消费
napi_value PauseRenderingJs(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    napi_value result = MakeObject(env);
    if (g_host == nullptr) {
        SetNumber(env, result, "ok", 0);
        return result;
    }
    bool paused = true;
    if (argc >= 1) {
        napi_get_value_bool(env, argv[0], &paused);
    }
    g_host->PauseRendering(paused);
    SetNumber(env, result, "ok", 1);
    SetNumber(env, result, "paused", paused ? 1 : 0);
    return result;
}

// resnapshotLastFrame() —— 停帧后重新拷一份稳定快照（见 osr_host.h 的说明）
napi_value ResnapshotLastFrameJs(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = MakeObject(env);
    if (g_host == nullptr) {
        SetNumber(env, result, "ok", 0);
        return result;
    }
    const bool ok = g_host->ResnapshotLastFrame();
    SetNumber(env, result, "ok", ok ? 1 : 0);
    return result;
}

// releaseRetainedFrame()
napi_value ReleaseRetainedFrameJs(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = MakeObject(env);
    if (g_host == nullptr) {
        SetNumber(env, result, "ok", 0);
        return result;
    }
    g_host->ReleaseRetainedFrame();
    SetNumber(env, result, "ok", 1);
    return result;
}

// 像素恒等自证（通路 B 最强的证据）:
//
// 做法: 宿主在采集结束时**保留**最后一帧 OSR 纹理（画面冻结在最末帧），本函数同时取两路像素:
//   路 A = 该纹理里的像素（GPU 回读，ReadCenterPixelBGRA 同族做法）
//   路 B = 屏幕上宿主窗口矩形里的像素（BitBlt from screen DC + CAPTUREBLT）
// 然后逐点比对。
//
// 为什么必须这样判，而不是"统计颜色数 / 亮度":
//   负控 NC-B1（静态页面）时宿主没有任何可合成帧，WS_EX_NOREDIRECTIONBITMAP 窗口在屏幕上
//   就是一块**透明洞**，BitBlt 抓到的是窗口后面的桌面。仅凭"像素够花 / 不够黑"会把它判成 PASS
//   （实测 blackRatio=0、meanLuma=26.6、distinctColors=274 —— 明明抓的是 IDE 界面）。
//   像素恒等则把这种误判彻底关掉: 桌面像素不可能等于 OSR 纹理像素。
//
// 阈值口径:
//   matchRatio = 两路逐点"每通道 diff <= 2"的像素占比。
//   BitBlt 走的是 8bpp 量化后的桌面表面，加上可能的 DWM 色彩管理，允许 ±2 的量化误差；
//   若纹理真的被合成上去，实测 matchRatio 接近 1.0；没合成上时接近 0。
//   判 PASS 需 matchRatio >= 0.98 且两路尺寸一致。
napi_value CompareScreenAndTextureJs(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

    napi_value result = MakeObject(env);
    SetNumber(env, result, "ok", 0);
    SetNumber(env, result, "matchRatio", 0.0);

    char outPathUtf8[1024] = {0};
    size_t pathLen = 0;
    if (argc >= 1) {
        napi_get_value_string_utf8(env, argv[0], outPathUtf8, sizeof(outPathUtf8) - 1,
                                   &pathLen);
    }
    wchar_t outPath[1024] = {0};
    if (pathLen > 0) {
        MultiByteToWideChar(CP_UTF8, 0, outPathUtf8, -1, outPath,
                            static_cast<int>(sizeof(outPath) / sizeof(outPath[0])));
    }

    if (g_host == nullptr) {
        SetString(env, result, "error", "host not init");
        return result;
    }
    HWND hwnd = reinterpret_cast<HWND>(g_host->WindowHandle());
    if (hwnd == nullptr || !IsWindow(hwnd)) {
        SetString(env, result, "error", "host hwnd invalid");
        return result;
    }

    // ---- 路 A: 保留的 OSR 纹理像素 ----
    ID3D11Texture2D* tex = nullptr;
    if (!g_host->GetRetainedFrame(&tex, nullptr, nullptr) || tex == nullptr) {
        SetString(env, result, "error", "no retained frame (host retained nothing)");
        return result;
    }
    D3D11_TEXTURE2D_DESC texDesc = {};
    tex->GetDesc(&texDesc);
    SetNumber(env, result, "texWidth", static_cast<double>(texDesc.Width));
    SetNumber(env, result, "texHeight", static_cast<double>(texDesc.Height));

    // 这张保留纹理属于**宿主设备**（它是 OpenSharedResource1 在宿主设备上打开的）。
    // 跨设备 CopyResource 是非法的（实测 map 直接失败），必须用宿主自己的设备/上下文回读。
    ID3D11Device* retainDevice = nullptr;
    ID3D11DeviceContext* retainCtx = nullptr;
    g_host->GetRetainedFrame(&tex, &retainDevice, &retainCtx);
    if (retainDevice == nullptr || retainCtx == nullptr) {
        SetString(env, result, "error", "host device unavailable");
        return result;
    }
    // 宿主 ctx 是渲染线程独占的: 比对期间必须暂停它，否则 CopyResource/Map 会和
    // 进行中的 Draw/Present1 抢同一个 immediate context（表现为 Map 返回失败或读到半帧）。
    g_host->PauseRendering(true);
    Sleep(40);   // 让渲染线程把手上那一帧做完并进入暂停态
    D3D11_TEXTURE2D_DESC stagingDesc = texDesc;
    stagingDesc.BindFlags = 0;
    stagingDesc.MiscFlags = 0;
    stagingDesc.Usage = D3D11_USAGE_STAGING;
    stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    stagingDesc.MipLevels = 1;
    stagingDesc.ArraySize = 1;
    ID3D11Texture2D* staging = nullptr;
    HRESULT hr = retainDevice->CreateTexture2D(&stagingDesc, nullptr, &staging);
    if (FAILED(hr) || staging == nullptr) {
        g_host->PauseRendering(false);
        SetString(env, result, "error", "create staging failed");
        return result;
    }
    retainCtx->CopyResource(staging, tex);
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    hr = retainCtx->Map(staging, 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr) || mapped.pData == nullptr) {
        staging->Release();
        g_host->PauseRendering(false);
        SetString(env, result, "error", "map staging failed");
        return result;
    }
    const int texW = static_cast<int>(texDesc.Width);
    const int texH = static_cast<int>(texDesc.Height);

    // ---- 路 B: 屏幕像素 ----
    //
    // 先取一份"桌面基线": 把宿主窗口临时隐藏，抓同一块屏幕矩形 —— 抓到的是窗口后面的
    // 桌面/其它窗口。再显示回来抓一份。两者的差异就是"我们的窗口真的占了这块地方"。
    // 这一步让"窗口其实是透明洞"这种假通过变得不可能。
    RECT rect = {};
    GetWindowRect(hwnd, &rect);
    const int scrW = static_cast<int>(rect.right - rect.left);
    const int scrH = static_cast<int>(rect.bottom - rect.top);
    SetNumber(env, result, "screenWidth", static_cast<double>(scrW));
    SetNumber(env, result, "screenHeight", static_cast<double>(scrH));

    // 桌面基线采集（隐藏窗口）
    std::vector<uint8_t> desktopPixels;
    {
        const BOOL wasVisible = IsWindowVisible(hwnd);
        ShowWindow(hwnd, SW_HIDE);
        Sleep(150);
        HDC refDc = GetDC(nullptr);
        HDC refMem = refDc != nullptr ? CreateCompatibleDC(refDc) : nullptr;
        HBITMAP refBitmap = (refDc != nullptr && scrW > 0 && scrH > 0)
                                ? CreateCompatibleBitmap(refDc, scrW, scrH)
                                : nullptr;
        if (refDc != nullptr && refMem != nullptr && refBitmap != nullptr) {
            HGDIOBJ refOld = SelectObject(refMem, refBitmap);
            BitBlt(refMem, 0, 0, scrW, scrH, refDc, rect.left, rect.top, SRCCOPY | CAPTUREBLT);
            BITMAPINFO refBmi = {};
            refBmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
            refBmi.bmiHeader.biWidth = scrW;
            refBmi.bmiHeader.biHeight = -scrH;
            refBmi.bmiHeader.biPlanes = 1;
            refBmi.bmiHeader.biBitCount = 32;
            refBmi.bmiHeader.biCompression = BI_RGB;
            desktopPixels.resize(static_cast<size_t>(scrW) * scrH * 4);
            if (GetDIBits(refMem, refBitmap, 0, static_cast<UINT>(scrH), desktopPixels.data(),
                          &refBmi, DIB_RGB_COLORS) == 0) {
                desktopPixels.clear();
            }
            SelectObject(refMem, refOld);
        }
        if (refBitmap != nullptr) DeleteObject(refBitmap);
        if (refMem != nullptr) DeleteDC(refMem);
        if (refDc != nullptr) ReleaseDC(nullptr, refDc);
        if (wasVisible) {
            ShowWindow(hwnd, SW_SHOWNA);
            Sleep(200);   // 等 DWM 把窗口内容重新合成上屏
        }
    }

    HDC screenDc = GetDC(nullptr);
    HDC memDc = screenDc != nullptr ? CreateCompatibleDC(screenDc) : nullptr;
    HBITMAP bitmap = screenDc != nullptr
                         ? CreateCompatibleBitmap(screenDc, scrW > 0 ? scrW : 1,
                                                  scrH > 0 ? scrH : 1)
                         : nullptr;
    std::vector<uint8_t> screenPixels;
    int comparedPixels = 0;
    int matchedPixels = 0;
    double meanAbsDiff = -1.0;

    if (screenDc != nullptr && memDc != nullptr && bitmap != nullptr && scrW > 0 &&
        scrH > 0) {
        HGDIOBJ oldObject = SelectObject(memDc, bitmap);
        BitBlt(memDc, 0, 0, scrW, scrH, screenDc, rect.left, rect.top, SRCCOPY | CAPTUREBLT);

        BITMAPINFO bmi = {};
        bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bmi.bmiHeader.biWidth = scrW;
        bmi.bmiHeader.biHeight = -scrH;
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;
        screenPixels.resize(static_cast<size_t>(scrW) * scrH * 4);
        if (GetDIBits(memDc, bitmap, 0, static_cast<UINT>(scrH), screenPixels.data(), &bmi,
                      DIB_RGB_COLORS) == 0) {
            screenPixels.clear();
        }

        // 可选: 落盘屏幕截图（便于人工核对），BMP 24bpp
        if (screenPixels.size() > 0 && pathLen > 0) {
            const int rowBytes = scrW * 3;
            const int padding = (4 - (rowBytes % 4)) % 4;
            const int imageBytes = (rowBytes + padding) * scrH;
            const int32_t offset = 54;
            FILE* file = nullptr;
            if (_wfopen_s(&file, outPath, L"wb") == 0 && file != nullptr) {
                uint8_t header[54] = {0};
                header[0] = 'B'; header[1] = 'M';
                const int32_t fileBytes = 54 + imageBytes;
                std::memcpy(header + 2, &fileBytes, 4);
                std::memcpy(header + 10, &offset, 4);
                const int32_t dibSize = 40;
                std::memcpy(header + 14, &dibSize, 4);
                std::memcpy(header + 18, &scrW, 4);
                const int32_t negHeight = -scrH;  // top-down，避免读图器上下颠倒
                std::memcpy(header + 22, &negHeight, 4);
                const uint16_t planes = 1;
                std::memcpy(header + 26, &planes, 2);
                const uint16_t bitCount = 24;
                std::memcpy(header + 28, &bitCount, 2);
                std::memcpy(header + 34, &imageBytes, 4);
                fwrite(header, 1, sizeof(header), file);
                const uint8_t zeros[3] = {0, 0, 0};
                for (int y = 0; y < scrH; ++y) {
                    const uint8_t* row = screenPixels.data() + static_cast<size_t>(y) * scrW * 4;
                    for (int x = 0; x < scrW; ++x) {
                        const uint8_t bgr[3] = {row[x * 4], row[x * 4 + 1], row[x * 4 + 2]};
                        fwrite(bgr, 1, 3, file);
                    }
                    if (padding > 0) fwrite(zeros, 1, static_cast<size_t>(padding), file);
                }
                fclose(file);
                SetString(env, result, "bmpPath", outPathUtf8);
            }
        }

        SelectObject(memDc, oldObject);
    }
    if (bitmap != nullptr) DeleteObject(bitmap);
    if (memDc != nullptr) DeleteDC(memDc);
    if (screenDc != nullptr) ReleaseDC(nullptr, screenDc);

    // ---- 屏幕稳定性自检 ----
    //
    // 比对前先确认"屏幕这一块画面已经不动了"。若还在变（DWM 队列里还有帧、或另外的
    // 窗口覆盖/动画），那么 matchRatio 无论多少都不该被当作合成结论 ——
    // 这是判据⑥能站得住脚的前提，也是我们排查"0.95 偶发"时的根因定位手段。
    double screenStabilityDiff = -1.0;
    if (screenPixels.size() > 0 && scrW > 0 && scrH > 0) {
        Sleep(120);
        HDC dc2 = GetDC(nullptr);
        HDC mem2 = dc2 != nullptr ? CreateCompatibleDC(dc2) : nullptr;
        HBITMAP bmp2 = (dc2 != nullptr) ? CreateCompatibleBitmap(dc2, scrW, scrH) : nullptr;
        if (dc2 != nullptr && mem2 != nullptr && bmp2 != nullptr) {
            HGDIOBJ old2 = SelectObject(mem2, bmp2);
            BitBlt(mem2, 0, 0, scrW, scrH, dc2, rect.left, rect.top, SRCCOPY | CAPTUREBLT);
            BITMAPINFO b2 = {};
            b2.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
            b2.bmiHeader.biWidth = scrW;
            b2.bmiHeader.biHeight = -scrH;
            b2.bmiHeader.biPlanes = 1;
            b2.bmiHeader.biBitCount = 32;
            b2.bmiHeader.biCompression = BI_RGB;
            std::vector<uint8_t> screen2(static_cast<size_t>(scrW) * scrH * 4);
            if (GetDIBits(mem2, bmp2, 0, static_cast<UINT>(scrH), screen2.data(), &b2,
                          DIB_RGB_COLORS) != 0) {
                double sum = 0.0;
                size_t count = 0;
                for (int y = 0; y < scrH; y += 2) {
                    const uint8_t* a = screenPixels.data() + static_cast<size_t>(y) * scrW * 4;
                    const uint8_t* c = screen2.data() + static_cast<size_t>(y) * scrW * 4;
                    for (int x = 0; x < scrW; x += 2) {
                        const uint8_t* pa = a + static_cast<size_t>(x) * 4;
                        const uint8_t* pc = c + static_cast<size_t>(x) * 4;
                        sum += (std::abs(static_cast<int>(pa[0]) - static_cast<int>(pc[0])) +
                                std::abs(static_cast<int>(pa[1]) - static_cast<int>(pc[1])) +
                                std::abs(static_cast<int>(pa[2]) - static_cast<int>(pc[2]))) / 3.0;
                        count += 1;
                    }
                }
                screenStabilityDiff = count > 0 ? sum / static_cast<double>(count) : -1.0;
            }
            SelectObject(mem2, old2);
        }
        if (bmp2 != nullptr) DeleteObject(bmp2);
        if (mem2 != nullptr) DeleteDC(mem2);
        if (dc2 != nullptr) ReleaseDC(nullptr, dc2);
    }
    SetNumber(env, result, "screenStabilityDiff", screenStabilityDiff);

    // ---- 逐点比对（尺寸必须一致，否则直接判不匹配）----
    const bool sizeEqual = screenPixels.size() > 0 && texW == scrW && texH == scrH;
    SetNumber(env, result, "sizeEqual", sizeEqual ? 1 : 0);
    if (sizeEqual) {
        const uint8_t* texRowBase = static_cast<const uint8_t*>(mapped.pData);
        double diffSum = 0.0;
        for (int y = 0; y < texH; ++y) {
            const uint8_t* texRow = texRowBase + static_cast<size_t>(y) * mapped.RowPitch;
            const uint8_t* scrRow = screenPixels.data() + static_cast<size_t>(y) * texW * 4;
            for (int x = 0; x < texW; ++x) {
                const uint8_t* tp = texRow + static_cast<size_t>(x) * 4;
                const uint8_t* sp = scrRow + static_cast<size_t>(x) * 4;
                const int db = std::abs(static_cast<int>(tp[0]) - static_cast<int>(sp[0]));
                const int dg = std::abs(static_cast<int>(tp[1]) - static_cast<int>(sp[1]));
                const int dr = std::abs(static_cast<int>(tp[2]) - static_cast<int>(sp[2]));
                const int maxDiff = db > dg ? (db > dr ? db : dr) : (dg > dr ? dg : dr);
                diffSum += (db + dg + dr) / 3.0;
                comparedPixels += 1;
                if (maxDiff <= 2) matchedPixels += 1;
            }
        }
        meanAbsDiff = comparedPixels > 0 ? diffSum / comparedPixels : -1.0;
    }
    retainCtx->Unmap(staging, 0);
    staging->Release();
    // 比对完成，恢复渲染（此后宿主仍持有保留帧，可继续展示冻结画面）。
    g_host->PauseRendering(false);

    // 桌面基线差异: 若窗口是透明洞，这里会接近 0（屏幕上就是桌面）。
    double desktopDiff = -1.0;
    if (desktopPixels.size() > 0 && sizeEqual) {
        double sum = 0.0;
        size_t count = 0;
        for (int y = 0; y < texH; ++y) {
            const uint8_t* scr = screenPixels.data() + static_cast<size_t>(y) * texW * 4;
            const uint8_t* dsk = desktopPixels.data() + static_cast<size_t>(y) * texW * 4;
            for (int x = 0; x < texW; ++x) {
                const uint8_t* a = scr + static_cast<size_t>(x) * 4;
                const uint8_t* b = dsk + static_cast<size_t>(x) * 4;
                sum += (std::abs(static_cast<int>(a[0]) - static_cast<int>(b[0])) +
                        std::abs(static_cast<int>(a[1]) - static_cast<int>(b[1])) +
                        std::abs(static_cast<int>(a[2]) - static_cast<int>(b[2]))) / 3.0;
                count += 1;
            }
        }
        desktopDiff = count > 0 ? sum / static_cast<double>(count) : -1.0;
    }

    // 归一化相关系数（Pearson，基于亮度）。
    //
    // 【为什么用相关系数而不是逐点相等】DWM 会把合成结果做一次显示色彩管理/量化，
    // 屏幕上的像素相对 OSR 纹理存在**全局色调映射**（实测中心点 RGB 由 #4e667f 变成 #1e3d5d）。
    // 逐点严格相等因此永远过不了 —— 那是错的判据。相关系数对"单调的色彩变换"免疫:
    // 只要屏幕上是这张纹理的内容，r 就接近 1；抓到的是桌面/别的窗口，r 接近 0。
    double correlation = 0.0;
    if (sizeEqual) {
        double sx = 0.0, sy = 0.0, sxx = 0.0, syy = 0.0, sxy = 0.0;
        size_t n = 0;
        const uint8_t* texBase = static_cast<const uint8_t*>(mapped.pData);
        for (int y = 0; y < texH; y += 2) {
            const uint8_t* texRow = texBase + static_cast<size_t>(y) * mapped.RowPitch;
            const uint8_t* scrRow = screenPixels.data() + static_cast<size_t>(y) * texW * 4;
            for (int x = 0; x < texW; x += 2) {
                const uint8_t* tp = texRow + static_cast<size_t>(x) * 4;
                const uint8_t* sp = scrRow + static_cast<size_t>(x) * 4;
                // 亮度（BT.601），纹理与屏幕用同一公式
                const double lx = 0.114 * tp[0] + 0.587 * tp[1] + 0.299 * tp[2];
                const double ly = 0.114 * sp[0] + 0.587 * sp[1] + 0.299 * sp[2];
                sx += lx; sy += ly; sxx += lx * lx; syy += ly * ly; sxy += lx * ly;
                n += 1;
            }
        }
        if (n > 1) {
            const double denomX = n * sxx - sx * sx;
            const double denomY = n * syy - sy * sy;
            if (denomX > 1e-9 && denomY > 1e-9) {
                correlation = (n * sxy - sx * sy) / std::sqrt(denomX * denomY);
            }
        }
    }

    const double matchRatioEarly =
        comparedPixels > 0 ? static_cast<double>(matchedPixels) / comparedPixels : 0.0;

    // 最佳平移诊断: 若 screen 相对 tex 存在 +/-3px 的整体偏移，找出让匹配率最高的 (dx,dy)。
    // 这条**只诊断、不参与判定**。用途: 区分"合成失败"和"抓到的是相邻一帧（内容有平移）"。
    // 实测证据: 页面 rAF 动画若还在跑，卡片位置在两帧间位移，逐点比对会得到 ~0.90 的匹配率，
    // 而最佳平移往往就是 (0,0) —— 说明不是错位，是内容真的在动。
    int bestDx = 0, bestDy = 0;
    double bestShiftRatio = matchRatioEarly;
    if (sizeEqual) {
        const uint8_t* texBase = static_cast<const uint8_t*>(mapped.pData);
        for (int dy = -3; dy <= 3; dy += 1) {
            for (int dx = -3; dx <= 3; dx += 1) {
                if (dx == 0 && dy == 0) continue;
                int matched = 0;
                int count = 0;
                for (int y = 3; y < texH - 3; y += 3) {
                    const int sy = y + dy;
                    if (sy < 0 || sy >= texH) continue;
                    const uint8_t* texRow = texBase + static_cast<size_t>(y) * mapped.RowPitch;
                    const uint8_t* scrRow =
                        screenPixels.data() + static_cast<size_t>(sy) * texW * 4;
                    for (int x = 3; x < texW - 3; x += 3) {
                        const int sx = x + dx;
                        if (sx < 0 || sx >= texW) continue;
                        const uint8_t* tp = texRow + static_cast<size_t>(x) * 4;
                        const uint8_t* sp = scrRow + static_cast<size_t>(sx) * 4;
                        const int db = std::abs(static_cast<int>(tp[0]) - static_cast<int>(sp[0]));
                        const int dg = std::abs(static_cast<int>(tp[1]) - static_cast<int>(sp[1]));
                        const int dr = std::abs(static_cast<int>(tp[2]) - static_cast<int>(sp[2]));
                        const int maxDiff = db > dg ? (db > dr ? db : dr) : (dg > dr ? dg : dr);
                        count += 1;
                        if (maxDiff <= 2) matched += 1;
                    }
                }
                if (count > 0) {
                    const double ratio = static_cast<double>(matched) / count;
                    if (ratio > bestShiftRatio) {
                        bestShiftRatio = ratio;
                        bestDx = dx;
                        bestDy = dy;
                    }
                }
            }
        }
    }
    SetNumber(env, result, "bestShiftDx", static_cast<double>(bestDx));
    SetNumber(env, result, "bestShiftDy", static_cast<double>(bestDy));
    SetNumber(env, result, "bestShiftRatio", bestShiftRatio);

    SetNumber(env, result, "desktopDiff", desktopDiff);
    SetNumber(env, result, "correlation", correlation);

    const double matchRatio =
        comparedPixels > 0 ? static_cast<double>(matchedPixels) / comparedPixels : 0.0;
    // 差异空间分布诊断: 把不一致像素计入 8x6 网格，找出集中在哪些区域。
    // 用途: 区分"整帧错""某块半透明区域错""边缘/圆角抗锯齿错"。
    if (sizeEqual) {
        const int kCols = 8;
        const int kRows = 6;
        int gridMatched[kRows][kCols] = {};
        int gridTotal[kRows][kCols] = {};
        const uint8_t* texBase = static_cast<const uint8_t*>(mapped.pData);
        for (int y = 0; y < texH; ++y) {
            const uint8_t* texRow = texBase + static_cast<size_t>(y) * mapped.RowPitch;
            const uint8_t* scrRow = screenPixels.data() + static_cast<size_t>(y) * texW * 4;
            const int gy = (y * kRows) / texH;
            for (int x = 0; x < texW; ++x) {
                const uint8_t* tp = texRow + static_cast<size_t>(x) * 4;
                const uint8_t* sp = scrRow + static_cast<size_t>(x) * 4;
                const int db = std::abs(static_cast<int>(tp[0]) - static_cast<int>(sp[0]));
                const int dg = std::abs(static_cast<int>(tp[1]) - static_cast<int>(sp[1]));
                const int dr = std::abs(static_cast<int>(tp[2]) - static_cast<int>(sp[2]));
                const int maxDiff = db > dg ? (db > dr ? db : dr) : (dg > dr ? dg : dr);
                const int gx = (x * kCols) / texW;
                gridTotal[gy][gx] += 1;
                if (maxDiff <= 2) gridMatched[gy][gx] += 1;
            }
        }
        char grid[512] = {0};
        size_t used = 0;
        for (int gy = 0; gy < kRows; ++gy) {
            for (int gx = 0; gx < kCols; ++gx) {
                const double ratio = gridTotal[gy][gx] > 0
                                         ? static_cast<double>(gridMatched[gy][gx]) /
                                               gridTotal[gy][gx]
                                         : 0.0;
                if (used + 16 < sizeof(grid)) {
                    const int written = std::snprintf(
                        grid + used, sizeof(grid) - used, "%.2f ", ratio);
                    if (written > 0) used += static_cast<size_t>(written);
                }
            }
        }
        SetString(env, result, "matchGrid8x6", grid);
    }

    SetNumber(env, result, "comparedPixels", static_cast<double>(comparedPixels));
    SetNumber(env, result, "matchedPixels", static_cast<double>(matchedPixels));
    SetNumber(env, result, "matchRatio", matchRatio);
    SetNumber(env, result, "meanAbsDiff", meanAbsDiff);

    // 中心像素双路对照（便于报告里贴一行直观数值）
    if (sizeEqual && texW > 0 && texH > 0) {
        const uint8_t* texRow =
            static_cast<const uint8_t*>(mapped.pData) + static_cast<size_t>(texH / 2) * mapped.RowPitch;
        const uint8_t* tp = texRow + static_cast<size_t>(texW / 2) * 4;
        const uint8_t* sp = screenPixels.data() + static_cast<size_t>(texH / 2) * texW * 4 +
                            static_cast<size_t>(texW / 2) * 4;
        char text[96] = {0};
        std::snprintf(text, sizeof(text), "tex=%u,%u,%u screen=%u,%u,%u", tp[0], tp[1], tp[2],
                      sp[0], sp[1], sp[2]);
        SetString(env, result, "centerPixelCompare", text);
    }

    SetNumber(env, result, "ok", 1);
    return result;
}

// hostShutdown()
napi_value HostShutdownJs(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value result = MakeObject(env);
    if (g_host == nullptr) {
        SetNumber(env, result, "ok", 0);
        SetNumber(env, result, "shutdownMs", 0);
        SetString(env, result, "error", "host not init");
        return result;
    }
    const double shutdownMs = g_host->Shutdown();
    delete g_host;
    g_host = nullptr;
    SetNumber(env, result, "ok", 1);
    SetNumber(env, result, "shutdownMs", shutdownMs);
    return result;
}

napi_value Init(napi_env env, napi_value exports) {
    const struct {
        const char* name;
        napi_callback callback;
    } functions[] = {
        {"openSharedTexture", OpenSharedTextureJs},
        {"hostInit", HostInitJs},
        {"hostPresent", HostPresentJs},
        {"retainLastFrame", RetainLastFrameJs},
        {"pauseRendering", PauseRenderingJs},
        {"resnapshotLastFrame", ResnapshotLastFrameJs},
        {"releaseRetainedFrame", ReleaseRetainedFrameJs},
        {"compareScreenAndTexture", CompareScreenAndTextureJs},
        {"hostStats", HostStatsJs},
        {"hostShutdown", HostShutdownJs},
    };
    for (const auto& entry : functions) {
        napi_value fn = nullptr;
        napi_create_function(env, entry.name, NAPI_AUTO_LENGTH, entry.callback, nullptr, &fn);
        napi_set_named_property(env, exports, entry.name, fn);
    }
    return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
