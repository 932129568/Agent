// glass_shm.h —— P09-C / Harbor Glass 共享内存节点协议（M1 仅冻结协议；参与编译在 M2/M3）
//
// 本头文件是 C++ 侧与 HLSL cbuffer 的唯一契约来源：
//   - 每个 HarborGlassNode 恰好 64 B，16 个节点 = 1024 B，与 shader 侧 cbuffer 逐字段对齐；
//   - APCA 反馈结构独立（16 B），不得合并进节点（否则破坏 64 B 步长）。
//
// 契约校验放在头文件里而不是 .cpp 里：任何 include 本头的 TU 都在编译期复核布局，
// 一旦有人改字段顺序/宽度，最先炸的是编译而不是运行期的花屏。
#pragma once

#include <stdint.h>
#include <stddef.h>   // offsetof 只从 <stddef.h> 取：<cstddef.h> 不存在（C1083），
                      // <cstddef> 虽可用但 offsetof 需 std:: 前缀，混用会踩坑

// 单个玻璃节点：矩形 + 参数 + 速度曲线 + 标志位，4 × float4 = 64 B。
// alignas(64) 让节点落在独立 cache line 上，GPU 侧按 float4 对齐上传。
struct alignas(64) HarborGlassNode {
    float rect[4];        // offset 0  : x, y, w, h
    float params[4];      // offset 16 : blur, tint, refraction, cornerRadius
    float velProfile[4];  // offset 32 : 速度曲线四控制点
    uint32_t flags[4];    // offset 48 : 位标志（dirty / hdr / occluded / reserved）
};                        // 共 64 B / 节点，16 节点 = 1024 B

// APCA 对比度反馈：由 CPU 侧回填给 UI 线程，独立于节点数组。
struct alignas(16) HarborApcaFeedback {
    float lstar, contrast, bgLstar, alpha;
};                        // 16 B

static_assert(sizeof(HarborGlassNode) == 64, "HarborGlassNode must be 64B");
static_assert(alignof(HarborGlassNode) == 64, "HarborGlassNode must be alignas(64)");
static_assert(sizeof(HarborGlassNode) * 16 == 1024, "16 nodes must be 1024B");
static_assert(sizeof(HarborApcaFeedback) == 16, "HarborApcaFeedback must be 16B");
static_assert(offsetof(HarborGlassNode, params) == 16, "params must be at offset 16");
