// kawase_cs.hlsl —— Dual Kawase 降/升采样，cs_5_0
//
// 硬约束：compute shader 里绝对不能出现 ddx/ddy（fxc 会报 X4532），
// 上采样取模糊一律走显式 SampleLevel，双线性权重由采样器给，不依赖导数。
//
// main_down : 18x18 groupshared 平铺（1 像素 halo）→ 5-tap 归约，走 LDS，源码里只有 ld
// main_up   : 9-tap 显式 SampleLevel（中心 4/16，轴向 2/16，对角 1/16）

cbuffer KawaseParams : register(b0)
{
    float2 gTexel;   // 1 / 源分辨率
    float2 gPad;
};

Texture2D<float4>  gSrc : register(t0);
SamplerState       gSmp : register(s0);
RWTexture2D<float4> gDst : register(u0);

#define TS 16
#define TILE (TS + 2)

groupshared float4 gTile[TILE][TILE];

[numthreads(TS, TS, 1)]
void main_down(uint3 gid : SV_GroupID, uint3 tid : SV_GroupThreadID)
{
    uint w, h;
    gSrc.GetDimensions(w, h);
    int2 base = int2(gid.xy * TS) - 1;
    int2 maxc = int2(w, h) - 1;

    // 324 个 texel / 256 线程 → 2 轮；越界用边缘钳制，避免多一次分支采样
    [unroll]
    for (uint k = tid.y * TS + tid.x; k < TILE * TILE; k += TS * TS)
    {
        int2 o = int2(k % TILE, k / TILE);
        int2 c = clamp(base + o, int2(0, 0), maxc);
        gTile[o.y][o.x] = gSrc.Load(int3(c, 0));
    }
    GroupMemoryBarrierWithGroupSync();

    // 5-tap：中心 0.5 + 四对角 0.125（Dual Kawase 降采样核）
    float4 c  = gTile[tid.y + 1][tid.x + 1];
    float4 ul = gTile[tid.y    ][tid.x    ];
    float4 ur = gTile[tid.y    ][tid.x + 2];
    float4 ll = gTile[tid.y + 2][tid.x    ];
    float4 lr = gTile[tid.y + 2][tid.x + 2];

    float4 o2 = c * 0.5 + (ul + ur + ll + lr) * 0.125;
    gDst[int2(gid.xy * TS) + int2(tid.xy)] = o2;
}

[numthreads(TS, TS, 1)]
void main_up(uint3 gid : SV_GroupID, uint3 tid : SV_GroupThreadID)
{
    uint w, h;
    gSrc.GetDimensions(w, h);
    int2 p = int2(gid.xy * TS) + int2(tid.xy);
    float2 uv = (float2(p) + 0.5) * gTexel;

    float4 s = gSrc.SampleLevel(gSmp, uv, 0) * 4.0;
    s += gSrc.SampleLevel(gSmp, uv + float2( gTexel.x, 0), 0) * 2.0;
    s += gSrc.SampleLevel(gSmp, uv + float2(-gTexel.x, 0), 0) * 2.0;
    s += gSrc.SampleLevel(gSmp, uv + float2(0,  gTexel.y), 0) * 2.0;
    s += gSrc.SampleLevel(gSmp, uv + float2(0, -gTexel.y), 0) * 2.0;
    s += gSrc.SampleLevel(gSmp, uv + float2( gTexel.x,  gTexel.y), 0);
    s += gSrc.SampleLevel(gSmp, uv + float2( gTexel.x, -gTexel.y), 0);
    s += gSrc.SampleLevel(gSmp, uv + float2(-gTexel.x,  gTexel.y), 0);
    s += gSrc.SampleLevel(gSmp, uv + float2(-gTexel.x, -gTexel.y), 0);

    gDst[p] = s * (1.0 / 16.0);
}
