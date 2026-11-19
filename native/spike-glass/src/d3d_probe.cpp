// d3d_probe.cpp —— D3D11 / DirectComposition 设备可建性探针
//
// 只回答一个问题：本机（含沙箱会话）能不能拿到 D3D11 设备与 DComposition 设备。
// 不做建窗、不做 SwapChain —— 那需要真实桌面会话，M2 再做。
#include <cstdio>
#include <windows.h>
#include <d3d11_1.h>
#include <dcomp.h>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dcomp.lib")
#pragma comment(lib, "dxgi.lib")

static void PrintHr(const char* tag, HRESULT hr)
{
    std::printf("%s hr=0x%08lX %s\n", tag,
                static_cast<unsigned long>(hr),
                SUCCEEDED(hr) ? "OK" : "FAILED");
}

int main()
{
    D3D_FEATURE_LEVEL lv[] = { D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0 };
    D3D_FEATURE_LEVEL got = D3D_FEATURE_LEVEL_11_0;
    ID3D11Device* d3d = nullptr;
    ID3D11DeviceContext* ctx = nullptr;

    HRESULT hrHw = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                     D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                     lv, _countof(lv), D3D11_SDK_VERSION,
                                     &d3d, &got, &ctx);
    PrintHr("D3D11CreateDevice(HARDWARE)", hrHw);

    if (FAILED(hrHw)) {
        HRESULT hrWarp = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr,
                                           D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                           lv, _countof(lv), D3D11_SDK_VERSION,
                                           &d3d, &got, &ctx);
        PrintHr("D3D11CreateDevice(WARP fallback)", hrWarp);
    }

    if (d3d) {
        std::printf("FeatureLevel=0x%04X\n", static_cast<unsigned>(got));
    }

    IDCompositionDevice* dcomp = nullptr;
    HRESULT hrDcomp = DCompositionCreateDevice2(nullptr, IID_PPV_ARGS(&dcomp));
    PrintHr("DCompositionCreateDevice2", hrDcomp);

    if (dcomp) dcomp->Release();
    if (ctx)  ctx->Release();
    if (d3d)  d3d->Release();
    return 0;
}
