// layout_probe.cpp —— 布局探针：把 glass_shm.h 的 static_assert 契约变成可读的运行时读数
//
// 编译期已由 5 条 static_assert 兜底；这里再把 sizeof / offsetof 打出来，
// 便于在报告里给出"编译期断言 + 运行期实测"双向一致的证据。
#include <cstdio>
#include <cstddef>

#include "glass_shm.h"

int main()
{
    std::printf("sizeof(HarborGlassNode)=%zu\n", sizeof(HarborGlassNode));
    std::printf("sizeof(HarborApcaFeedback)=%zu\n", sizeof(HarborApcaFeedback));
    std::printf("offsetof(HarborGlassNode, rect)=%zu\n", offsetof(HarborGlassNode, rect));
    std::printf("offsetof(HarborGlassNode, params)=%zu\n", offsetof(HarborGlassNode, params));
    std::printf("offsetof(HarborGlassNode, velProfile)=%zu\n", offsetof(HarborGlassNode, velProfile));
    std::printf("offsetof(HarborGlassNode, flags)=%zu\n", offsetof(HarborGlassNode, flags));
    std::printf("alignof(HarborGlassNode)=%zu\n", alignof(HarborGlassNode));
    std::printf("16*sizeof(HarborGlassNode)=%zu\n", sizeof(HarborGlassNode) * 16);
    return 0;
}
