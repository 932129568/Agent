// dcomp_host.cpp —— P09 Spike: DirectComposition 直通宿主骨架（M1 只到"设备能建"级）
//
// 沙箱/无桌面会话下建窗必然静默失败，故 Init 只做 D3D11 设备 + DComposition 设备的创建，
// 建窗 / SwapChain / DWM 属性留到 M2。编译用 /c（只编译不链接）可绕开 dcomp.lib 链接需求。
#include <cstdint>
#include <stdlib.h>
#include <windows.h>
#include <d3d11_1.h>
#include <dcomp.h>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dcomp.lib")

class SpikeDCompHost {
public:
    bool Init(HINSTANCE hInst, bool hdrFp16);
private:
    ID3D11Device*        d3d_   = nullptr;
    ID3D11DeviceContext* ctx_   = nullptr;
    IDCompositionDevice* dcomp_ = nullptr;
    HWND                 hwnd_  = nullptr;
};

bool SpikeDCompHost::Init(HINSTANCE hInst, bool hdrFp16)
{
    (void)hInst; (void)hdrFp16;

    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    D3D_FEATURE_LEVEL lv[] = { D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0 };
    D3D_FEATURE_LEVEL got = D3D_FEATURE_LEVEL_11_0;
    HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                   flags, lv, _countof(lv),
                                   D3D11_SDK_VERSION, &d3d_, &got, &ctx_);
    if (FAILED(hr)) return false;

    hr = DCompositionCreateDevice2(nullptr, IID_PPV_ARGS(&dcomp_));
    if (FAILED(hr)) return false;

    // TODO(M2): CreateWindowEx / CreateSwapChainForComposition / DwmSetWindowAttribute
    return true;
}
