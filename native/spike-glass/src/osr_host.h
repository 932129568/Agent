// osr_host.h -- 通路 B: 原生 DComp 宿主（单交换链）公开接口
//
// 设计要点（对应任务书 B 项）:
//   * 只建 **一条** CreateSwapChainForComposition 交换链（"单链"），绝不双窗双链。
//   * 窗口用 WS_EX_NOREDIRECTIONBITMAP（DComp 合成的硬前提，否则 DWM 会把窗口内容擦成黑）。
//   * 窗口 / 设备 / 交换链 / 渲染循环全部由**专属工作线程**持有并跑消息泵，
//     因为 Electron 主线程还要处理 paint 事件与 JS 定时器，Present1(1) 每次阻塞 ~6ms
//     （165Hz vsync），放在主线程会把 OSR 出帧节奏拖坏。
//   * NT 句柄的"接收"方式 = **由 addon 在进程内桥接**（任务书允许的三种之一）。
//     优点: 无需跨进程 DuplicateHandle / 命名管道，句柄天然有效，零 IPC 失败面。
//     SubmitSharedTexture 在主线程同步完成 OpenSharedResource1 + CreateSRV（微秒级），
//     此后 Electron 侧 texture.release() 即可安全放手，资源引用已由本进程持有。
#ifndef HARBOR_OSR_HOST_H_
#define HARBOR_OSR_HOST_H_

#include <cstddef>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
// 必须在 <windows.h> 之后: 保留帧接口要用 ID3D11Texture2D / ID3D11Device / ID3D11DeviceContext。
// 顺序反了会报一串误导性 C2065/C2143（HRESULT/IUnknown 未定义）。
#include <d3d11_1.h>

namespace harbor {
namespace osr {

struct HarborOsrHostConfig {
    UINT width = 640;
    UINT height = 400;
    const wchar_t* title = L"Harbor OSR Host (single swapchain)";
    int targetFps = 60;
};

// 宿主侧统计（P0-3 判据 ④/⑤ 与"退出不卡死"的证据来源）。
struct HarborOsrHostStats {
    unsigned long long submitted = 0;      // 主线程提交的帧数
    unsigned long long openOk = 0;         // OpenSharedResource1 成功次数
    unsigned long long openFail = 0;       // 打开失败次数（负控 B3 应为帧数）
    unsigned long long dropped = 0;        // 因渲染线程来不及而丢弃的过期帧
    unsigned long long rendered = 0;       // 真正画进后缓冲的帧数
    unsigned long long presented = 0;      // Present1 返回 S_OK 的次数
    unsigned long long presentFailed = 0;  // Present1 失败次数
    unsigned long long waitTimeouts = 0;   // 帧延迟等待对象超时次数
    unsigned long long resizeFailed = 0;   // 交换链按真实纹理尺寸重建失败次数（0 = 像素精确）
    unsigned long long lastOpenHr = 0;     // 最近一次打开结果（HRESULT）
    unsigned long long lastPresentHr = 0;  // 最近一次 Present1 结果（HRESULT）
    double lastPresentMs = 0.0;            // 最近一次 Present1 阻塞时长
    double avgPresentMs = 0.0;             // Present1 平均阻塞时长
    double maxPresentMs = 0.0;             // Present1 最大阻塞时长
    double lifeMs = 0.0;                   // 宿主从建链到取统计的存活时长

    // ---- D2 主统计量：Present→Present 间隔分布 ----
    // 【为什么必须是「间隔」而不是「Present1 调用耗时」】D2 的主统计量是节拍分布
    // （p95/p99 + 掉拍率），而 avgPresentMs 只是 Present1 调用本身阻塞了多久。
    // 两者是不同的量：SyncInterval=1 时 Present1 可能立即返回（阻塞很短），
    // 但真实帧间隔仍被 vsync 钉住。拿调用耗时当节拍，会得到「一切都很快」的假绿。
    double intervalP50Ms = 0.0;            // Present 间隔中位数 = 实测 vsync 基准
    double intervalP95Ms = 0.0;
    double intervalP99Ms = 0.0;
    double intervalMaxMs = 0.0;
    double intervalMinMs = 0.0;
    unsigned long long intervalSamples = 0;  // 参与分布的间隔个数
    unsigned long long drops = 0;            // 间隔 >= 2 × vsync 基准的次数
    double dropRate = 0.0;                   // drops / intervalSamples

    unsigned int width = 0;
    unsigned int height = 0;
    unsigned int dpi = 0;
    int dpiAwareness = 0;  // 0=UNAWARE 1=SYSTEM 2=PER_MONITOR
    int ready = 0;
};

// 原生 DComp 单链宿主。生命周期: Init -> (SubmitSharedTexture)* -> Shutdown。
class HarborOsrHost {
public:
    HarborOsrHost();
    ~HarborOsrHost();

    HarborOsrHost(const HarborOsrHost&) = delete;
    HarborOsrHost& operator=(const HarborOsrHost&) = delete;

    // 建窗 + 建链 + 起渲染线程。失败时把原因写进 errText 并返回 false。
    bool Init(const HarborOsrHostConfig& config, char* errText, size_t errTextLen);

    bool IsReady() const;

    // 主线程调用: 打开 NT 共享纹理并入队（只保留最新帧）。
    // 返回是否成功入队；outOpenHr 原样传出 OpenSharedResource1 的 HRESULT（负控要看非 0）。
    bool SubmitSharedTexture(HANDLE ntHandle, HRESULT* outOpenHr);

    void GetStats(HarborOsrHostStats* out) const;

    // 宿主窗口句柄（供截屏自证用；窗口由工作线程创建，句柄值本身可跨线程读）。
    // 返回 nullptr 表示尚未就绪。
    void* WindowHandle() const;

    // 让渲染线程**快照**最后一帧到宿主私有纹理，供像素恒等自证使用。
    //
    // 【为什么是"拷贝"而不是"保留引用"】OSR 共享纹理来自 Chromium 的**纹理池**，
    // 我们 OpenSharedResource1 只是持有一次引用，**内容仍会被下一帧覆盖**（池会复用同一块显存）。
    // 实测症状: 保留引用的做法会让 matchRatio 在 1.00000 与 0.90 之间随机跳 ——
    // 那是"纹理里已经是下一帧、屏幕上还是上一帧"（卡片旋转角不同）。
    // 因此这里 CopyResource 到宿主的私有纹理，此后内容不再被任何人改写。
    void RetainLastFrame(bool retain);

    // 【保持兼容的空实现】事后重新快照共享纹理是走不通的路，原因见 .cpp 里的说明。
    // 返回当前是否已有一份快照。真正的快照发生在 WorkerMain 里（当帧 CopyResource + Flush）。
    bool ResnapshotLastFrame();

    // 取出被快照的纹理（调用方**不要** Release，所有权仍在宿主）。
    // 这张纹理是宿主私有副本，内容稳定。返回 false 表示当前没有快照。
    bool GetRetainedFrame(ID3D11Texture2D** outTex, ID3D11Device** outDevice,
                          ID3D11DeviceContext** outCtx) const;

    // 释放保留帧。渲染线程可能正在用，内部会先停帧再放��
    void ReleaseRetainedFrame();

    // 暂停/恢复渲染线程的出帧消费（消息泵继续跑，窗口保持响应）。
    // 用途: 像素恒等比对需要在宿主自己的设备/上下文上做 CopyResource，
    // 而宿主 ctx 是渲染线程独占的 —— 必须先暂停，否则会与进行中的 Draw/Present1 竞争。
    void PauseRendering(bool paused);

    // 在宿主自己的设备/上下文上把某张纹理读回中心像素（供跨设备场景比对）。
    // 返回 S_OK 表示成功；outBgra 收到 "B,G,R,A" 文本。
    HRESULT ReadCenterPixelOfTexture(ID3D11Texture2D* tex, char* outBgra,
                                     size_t outBgraLen);

    // 停线程 + 拆 DComp + 销窗 + 释放全部 D3D 对象。返回耗时（毫秒），用于证明不卡死。
    double Shutdown();

private:
    struct Impl;
    Impl* impl_ = nullptr;
};

}  // namespace osr
}  // namespace harbor

#endif  // HARBOR_OSR_HOST_H_
