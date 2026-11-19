// osr_bridge.cpp —— P09 OSR 共享纹理桥（M1 只落签名与主体，M2 接 Electron 侧 NT handle）
//
// 说明：<windows.h> 必须先于 d3d11_1.h，否则 DXGI/D3D 头里的 HRESULT/IUnknown
// 缺定义，会报一串误导性的 C2065/C2143。
#include <cstdint>   // 必须：uint8_t / size_t，缺它先报的是 C2143 语法错
#include <cstddef>
#include <windows.h>
#include <d3d11_1.h>

// 把 Electron 侧渲染完成的一帧（BGRA8，pixels/bytes 描述 CPU 侧快照）登记到 D3D11 设备上。
// 真正的零拷贝路径走 OpenSharedResource1(NT handle)，M1 仅保证可编译、可链接、可被调用。
HRESULT SubmitElectronSharedTexture(ID3D11Device1* dev1,
                                    const uint8_t* pixels,
                                    size_t bytes)
{
    if (!dev1 || !pixels || bytes == 0) return E_INVALIDARG;

    // TODO(M2): ntHandle 由 Electron 侧 (gpu_process / shared_texture) 通过 IPC 传入；
    //           当前为占位，OpenSharedResource1 会返回 E_INVALIDARG，这是预期行为。
    HANDLE ntHandle = nullptr;

    ID3D11Texture2D* uiTex = nullptr;
    HRESULT hr = dev1->OpenSharedResource1(
        ntHandle, IID_PPV_ARGS(&uiTex));
    if (uiTex) uiTex->Release();
    return hr;
}
