// osr_bridge.h -- 通路 B / P09: Electron OSR 共享纹理 -> 原生 D3D11 桥（公开接口）
//
// 【为什么存在这个头】
// M1 时代 osr_bridge.cpp 只有一个占位签名，且参数是 CPU 像素数组（见 cpp 顶部对照说明）。
// M2 把接口重写为「NT 句柄 -> (纹理, SRV)」，让 osr_host.cpp 与 addon.cpp 共用同一实现，
// 避免两处各写一遍 OpenSharedResource1 造成行为漂移。
//
// 【头文件顺序硬约束】
// <windows.h> 必须先于 d3d11_1.h / dxgi1_2.h，否则 HRESULT / IUnknown / LUID 等类型
// 尚未定义，MSVC 会报一串看起来完全无关的 C2065（未声明标识符）与 C2143（语法错误）。
#ifndef HARBOR_OSR_BRIDGE_H_
#define HARBOR_OSR_BRIDGE_H_

#include <cstddef>
#include <cstdint>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <d3d11_1.h>

namespace harbor {
namespace osr {

// 一帧 Electron OSR 共享纹理在原生侧的可用视图。
// tex 是 ID3D11Texture2D（可继续 CopyResource），srv 是可被 PS 采样的着色器资源视图。
// 两者必须成对释放（见 ReleaseSharedTexture）。
struct SharedTextureView {
    ID3D11Texture2D* tex = nullptr;
    ID3D11ShaderResourceView* srv = nullptr;
    UINT width = 0;
    UINT height = 0;
    DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN;
};

// 打开 Electron 侧导出的 NT 共享纹理句柄（零拷贝路径）。
//
// 参数:
//   device1  -- 已 QueryInterface 到 ID3D11Device1 的设备（OpenSharedResource1 只在 Device1+ 上）。
//   ntHandle -- Electron `texture.textureInfo.handle.ntHandle` 里的 8 字节句柄值。
//               **注意不是 `info.sharedTextureHandle`**，源方案文档在这一点上是错的。
//   outTex   -- 成功时返回新引用（调用方负责 Release）。
//   outSrv   -- 成功时返回新引用（调用方负责 Release）。
//
// 返回:
//   S_OK 表示纹理已打开且 SRV 已创建；其余 HRESULT 通过它原样上报（负控要看到非 0）。
//   失败时 *outTex / *outSrv 均被置为 nullptr。
//
// 生命周期:
//   OpenSharedResource1 成功即在本进程持有一次共享资源引用，此后即使 Electron 侧调用了
//   `texture.release()` 关闭了它自己的 NT 句柄，本进程的纹理依然有效。因此调用顺序应为
//   「先 Open，再 release Electron 侧 texture」。释放用 ReleaseSharedTexture。
HRESULT OpenSharedTexture(ID3D11Device1* device1,
                          HANDLE ntHandle,
                          ID3D11Texture2D** outTex,
                          ID3D11ShaderResourceView** outSrv);

// 分步诊断: OpenSharedTexture 只有一个合并 HRESULT，但报告需要分别看到
// 「OpenSharedResource1 拒绝」还是「SRV 建不出来」。按线程保存，避免加锁。
struct OpenSharedTextureDiagnostics {
    HRESULT openHr = E_FAIL;
    HRESULT srvHr = E_FAIL;
};

// 取当前线程最近一次 OpenSharedTexture 的分步结果（仅诊断用）。
OpenSharedTextureDiagnostics GetLastOpenSharedTextureDiagnostics();

// 读回纹理描述（宽高 / 格式），用于把实际尺寸上报给 JS 侧做断言。
HRESULT DescribeSharedTexture(ID3D11Texture2D* tex, SharedTextureView* out);

// 成对释放。任一指针可为 nullptr。
// 说明: 这里不做 ctx->Flush()，因为只做 SRV 采样/CopyResource 的纹理在 Release 时
//       D3D11 运行时会自己处理挂起命令；需要「释放后立刻正常退出」的证明见
//       FlushAndReleaseSharedTexture。
void ReleaseSharedTexture(ID3D11Texture2D* tex, ID3D11ShaderResourceView* srv);

// 释放前显式 Flush，用于证明「Release 之后进程能正常退出、不卡在 GPU 同步上」（P0-3 判据）。
void FlushAndReleaseSharedTexture(ID3D11DeviceContext* ctx,
                                  ID3D11Texture2D* tex,
                                  ID3D11ShaderResourceView* srv);

// 取证专用：把纹理 CopyResource 到 staging 并读回中心像素（BGRA 文本，如 "255,255,255,255"）。
// ⚠️ 这条路径会做一次 GPU->CPU 全帧回读，**只允许在取证/断言里用**，
//    绝不允许放在合成循环里（那正是源方案明令禁止的慢路）。
HRESULT ReadCenterPixelBGRA(ID3D11Device* device,
                            ID3D11DeviceContext* ctx,
                            ID3D11Texture2D* tex,
                            char* outText,
                            size_t outTextLen);

}  // namespace osr
}  // namespace harbor

#endif  // HARBOR_OSR_BRIDGE_H_
