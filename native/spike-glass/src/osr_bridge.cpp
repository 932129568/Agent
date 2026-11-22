// osr_bridge.cpp -- 通路 B / P09: Electron 45 OSR 共享纹理 -> 原生 D3D11 桥
//
// ============================================================================
// 【M2 签名重写对照 —— 旧签名为什么是错的】
//
//   旧 (M1 占位, 已废弃):
//       HRESULT SubmitElectronSharedTexture(ID3D11Device1* dev1,
//                                           const uint8_t* pixels,
//                                           size_t bytes);
//   - 它的入参是 CPU 侧像素数组，对应「GPU 回读 -> 内存 -> 再上传 GPU」的慢路。
//   - 源方案 (R101) 明令禁止这条路径: 640x400 BGRA 单帧 1.0MB，60fps 就是 60MB/s
//     的 PCIe 往返 + 两次全帧拷贝，还会引入 GPU->CPU 同步点（每帧掉到 100fps 级）。
//   - 更致命的是它连"句柄"都拿不到: 函数体里 HANDLE ntHandle = nullptr 是写死的占位，
//     所以旧签名无论调多少次都必然返回 E_INVALIDARG，无法作为闸门。
//
//   新 (M2 实装):
//       HRESULT OpenSharedTexture(ID3D11Device1* device1,
//                                 HANDLE ntHandle,                    <-- 关键: NT 共享句柄
//                                 ID3D11Texture2D** outTex,
//                                 ID3D11ShaderResourceView** outSrv);
//   - 走 OpenSharedResource1: 零拷贝，原生设备与 Chromium GPU 进程共用同一块显存。
//   - 实测字段名是 `texture.textureInfo.handle.ntHandle`（Buffer, 8 字节），
//     **不是** 源方案文档写的 `textureInfo.sharedTextureHandle` —— 文档此处是错的。
//   - 同时创建 SRV，因为合成必须在 PS 里采样这张 UI 纹理（CopyResource 要求尺寸格式完全一致，
//     窗口和 UI 纹理一旦不同尺寸就废了）。
// ============================================================================
//
// 【包含顺序硬约束（踩过坑，勿动）】
//   1) <windows.h> 必须先于 <d3d11_1.h>：否则 HRESULT/IUnknown/LUID 未定义，
//      MSVC 报一串误导性 C2065（未声明标识符）/ C2143（语法错误）。
//   2) <cstdint> / <cstddef> 必须显式包含：缺它时先报的是 C2143 语法错误（uint8_t 未声明），
//      现象看起来像头文件顺序问题，实际是标准头缺失。

#include "osr_bridge.h"

#include <cstdio>
#include <cstring>

namespace harbor {
namespace osr {
namespace {

// 线程局部: 只服务诊断上报，不参与控制流。
thread_local OpenSharedTextureDiagnostics g_lastDiagnostics;

}  // namespace

OpenSharedTextureDiagnostics GetLastOpenSharedTextureDiagnostics() {
    return g_lastDiagnostics;
}

HRESULT OpenSharedTexture(ID3D11Device1* device1,
                          HANDLE ntHandle,
                          ID3D11Texture2D** outTex,
                          ID3D11ShaderResourceView** outSrv) {
    // 契约: 失败时调用方拿到的必须是 nullptr，绝不能是野指针。
    if (outTex != nullptr) *outTex = nullptr;
    if (outSrv != nullptr) *outSrv = nullptr;
    g_lastDiagnostics.openHr = E_PENDING;
    g_lastDiagnostics.srvHr = E_PENDING;

    if (device1 == nullptr) return E_POINTER;
    if (outTex == nullptr || outSrv == nullptr) return E_POINTER;
    // NULL 句柄就是负控要的路径: OpenSharedResource1 会返回 E_INVALIDARG，
    // 这里不提前拦掉，保证负控测的是"D3D 真的拒绝了"，而不是"我们提前 return 了"。
    if (ntHandle == nullptr) {
        // 传真实输出指针（不能传 nullptr 当 out 参数，那是 UB）。
        ID3D11Texture2D* dummy = nullptr;
        HRESULT hrNull = device1->OpenSharedResource1(
            ntHandle, __uuidof(ID3D11Texture2D),
            reinterpret_cast<void**>(&dummy));
        if (dummy != nullptr) dummy->Release();
        g_lastDiagnostics.openHr = hrNull;
        g_lastDiagnostics.srvHr = E_FAIL;
        return FAILED(hrNull) ? hrNull : E_INVALIDARG;
    }

    ID3D11Texture2D* tex = nullptr;
    HRESULT hr = device1->OpenSharedResource1(
        ntHandle, __uuidof(ID3D11Texture2D),
        reinterpret_cast<void**>(&tex));
    g_lastDiagnostics.openHr = hr;
    g_lastDiagnostics.srvHr = E_FAIL;
    if (FAILED(hr) || tex == nullptr) {
        if (tex != nullptr) tex->Release();
        return FAILED(hr) ? hr : E_FAIL;
    }

    ID3D11ShaderResourceView* srv = nullptr;
    HRESULT srvHr = device1->CreateShaderResourceView(tex, nullptr, &srv);
    g_lastDiagnostics.srvHr = srvHr;
    if (FAILED(srvHr) || srv == nullptr) {
        // SRV 建不出来等于这张纹理对合成无用，按失败处理并回滚纹理引用，
        // 否则调用方会拿着一半成功的状态继续跑。
        if (srv != nullptr) srv->Release();
        tex->Release();
        return FAILED(srvHr) ? srvHr : E_FAIL;
    }

    *outTex = tex;
    *outSrv = srv;
    return S_OK;
}

HRESULT DescribeSharedTexture(ID3D11Texture2D* tex, SharedTextureView* out) {
    if (tex == nullptr || out == nullptr) return E_POINTER;
    D3D11_TEXTURE2D_DESC desc = {};
    tex->GetDesc(&desc);
    out->tex = tex;
    out->width = desc.Width;
    out->height = desc.Height;
    out->format = desc.Format;
    return S_OK;
}

void ReleaseSharedTexture(ID3D11Texture2D* tex, ID3D11ShaderResourceView* srv) {
    if (srv != nullptr) srv->Release();
    if (tex != nullptr) tex->Release();
}

void FlushAndReleaseSharedTexture(ID3D11DeviceContext* ctx,
                                  ID3D11Texture2D* tex,
                                  ID3D11ShaderResourceView* srv) {
    // 先解绑再 Flush 再释放：若纹理还绑在管线上，Release 只是延迟销毁，
    // 进程退出时驱动会在析构里补一次同步，表现为"关窗卡几百毫秒"。
    // 显式解绑 + Flush 让这一帧的 GPU 工作当场落地，退出路径干净。
    if (ctx != nullptr) {
        ID3D11ShaderResourceView* nullSrv[1] = {nullptr};
        ctx->PSSetShaderResources(0, 1, nullSrv);
        ctx->Flush();
    }
    ReleaseSharedTexture(tex, srv);
}

HRESULT ReadCenterPixelBGRA(ID3D11Device* device,
                            ID3D11DeviceContext* ctx,
                            ID3D11Texture2D* tex,
                            char* outText,
                            size_t outTextLen) {
    if (device == nullptr || ctx == nullptr || tex == nullptr) return E_POINTER;
    if (outText == nullptr || outTextLen < 8) return E_POINTER;
    outText[0] = '\0';

    D3D11_TEXTURE2D_DESC desc = {};
    tex->GetDesc(&desc);
    if (desc.Width == 0 || desc.Height == 0) return E_FAIL;

    D3D11_TEXTURE2D_DESC stagingDesc = desc;
    stagingDesc.BindFlags = 0;
    stagingDesc.MiscFlags = 0;
    stagingDesc.Usage = D3D11_USAGE_STAGING;
    stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    stagingDesc.MipLevels = 1;
    stagingDesc.ArraySize = 1;

    ID3D11Texture2D* staging = nullptr;
    HRESULT hr = device->CreateTexture2D(&stagingDesc, nullptr, &staging);
    if (FAILED(hr) || staging == nullptr) {
        if (staging != nullptr) staging->Release();
        return FAILED(hr) ? hr : E_FAIL;
    }

    ctx->CopyResource(staging, tex);
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    hr = ctx->Map(staging, 0, D3D11_MAP_READ, 0, &mapped);
    if (SUCCEEDED(hr) && mapped.pData != nullptr) {
        const uint8_t* row = static_cast<const uint8_t*>(mapped.pData) +
                             static_cast<size_t>(desc.Height / 2) * mapped.RowPitch;
        const uint8_t* px = row + static_cast<size_t>(desc.Width / 2) * 4;
        std::snprintf(outText, outTextLen, "%u,%u,%u,%u",
                      static_cast<unsigned>(px[0]), static_cast<unsigned>(px[1]),
                      static_cast<unsigned>(px[2]), static_cast<unsigned>(px[3]));
        ctx->Unmap(staging, 0);
    }
    staging->Release();
    return hr;
}

}  // namespace osr
}  // namespace harbor
