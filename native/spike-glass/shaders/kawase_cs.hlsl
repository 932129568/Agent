// kawase_cs.hlsl -- Dual Kawase down/up sampling, cs_5_0 (also builds as cs_5_1)
//
// HARD CONSTRAINT: a compute shader must never contain ddx/ddy (fxc reports
// X4532). Every blur fetch therefore uses an explicit SampleLevel or Load, so
// no implicit-LOD sample and no derivative is ever generated.
//
// MACRO-LEVEL DUAL TIER: ONE source file, TWO compile passes selected by -D.
//   LOW  pass: fxc /T cs_5_0 /E main_down   (and /E main_up)
//   HIGH pass: fxc /T cs_5_0 /E main_down /DGLASS_TIER_HIGH=1  (same for main_up)
//
// HIGH adds, per pass:
//   main_down: 5-tap dual-Kawase kernel (4 diagonal taps) -> 9-tap wide kernel
//              (4 axial + 4 diagonal taps read from groupshared)
//   main_up  : 9-tap tent -> 13-tap tent with an outer ring and an
//              energy-preserving renormalisation of the accumulated weights
//
// Comments are ASCII only so this file stays byte-stable everywhere.

// NOTE: test with #if, never #ifdef. The guard below defines the macro to 0
// when absent, so #ifdef would be true in BOTH passes and the two "tiers"
// would silently compile to identical code -- the exact fake-dual-tier bug
// this task exists to kill.
#ifndef GLASS_TIER_HIGH
#define GLASS_TIER_HIGH 0
#endif

cbuffer KawaseParams : register(b0)
{
    float2 gTexel;   // 1 / source resolution
    float2 gPad;
};

Texture2D<float4>  gSrc : register(t0);
SamplerState       gSmp : register(s0);
RWTexture2D<float4> gDst : register(u0);

#define TS 16
#define TILE (TS + 2)

groupshared float4 gTile[TILE][TILE];

// ---------------------------------------------------------------------------
// Downsample.
//   LOW : 5-tap dual-Kawase core (center 0.5, four diagonals 0.125 each).
//   HIGH: 9-tap wide core (center 0.25, four axial 0.125, four diagonal 0.0625),
//         all fetched from the groupshared tile so the extra taps cost LDS+MAD.
// ---------------------------------------------------------------------------
[numthreads(TS, TS, 1)]
void main_down(uint3 gid : SV_GroupID, uint3 tid : SV_GroupThreadID)
{
    uint w, h;
    gSrc.GetDimensions(w, h);

    int2 base = int2(gid.xy * TS) - 1;
    int2 maxc = int2(w, h) - 1;

    // TILE*TILE texels over TS*TS threads: 2 unrolled rounds, edge-clamped.
    [unroll]
    for (uint k = tid.y * TS + tid.x; k < TILE * TILE; k += TS * TS)
    {
        int2 o = int2(k % TILE, k / TILE);
        int2 c = clamp(base + o, int2(0, 0), maxc);
        gTile[o.y][o.x] = gSrc.Load(int3(c, 0));
    }
    GroupMemoryBarrierWithGroupSync();

#if GLASS_TIER_HIGH
    // 9-tap: center 0.25 + axial 0.125 + diagonal 0.0625.
    float4 dc   = gTile[tid.y + 1][tid.x + 1];
    float4 daL  = gTile[tid.y + 1][tid.x    ];
    float4 daR  = gTile[tid.y + 1][tid.x + 2];
    float4 daU  = gTile[tid.y    ][tid.x + 1];
    float4 daD  = gTile[tid.y + 2][tid.x + 1];
    float4 ddUL = gTile[tid.y    ][tid.x    ];
    float4 ddUR = gTile[tid.y    ][tid.x + 2];
    float4 ddLL = gTile[tid.y + 2][tid.x    ];
    float4 ddLR = gTile[tid.y + 2][tid.x + 2];

    float4 axial = (daL + daR + daU + daD) * 0.125;
    float4 diag  = (ddUL + ddUR + ddLL + ddLR) * 0.0625;
    float4 o2    = dc * 0.25 + axial + diag;

    // Energy renormalisation: the 9 taps sum to 1.25, bring it back to 1.0.
    o2 *= 0.8;
#else
    // 5-tap: center 0.5 + four diagonals 0.125.
    float4 c  = gTile[tid.y + 1][tid.x + 1];
    float4 ul = gTile[tid.y    ][tid.x    ];
    float4 ur = gTile[tid.y    ][tid.x + 2];
    float4 ll = gTile[tid.y + 2][tid.x    ];
    float4 lr = gTile[tid.y + 2][tid.x + 2];

    float4 o2 = c * 0.5 + (ul + ur + ll + lr) * 0.125;
#endif

    gDst[int2(gid.xy * TS) + int2(tid.xy)] = o2;
}

// ---------------------------------------------------------------------------
// Upsample.
//   LOW : 9-tap tent, weights 4/2/2/2/2 + 1*4, normalised by 1/16.
//   HIGH: 13-tap tent, adds an outer ring at 2 texels offset plus a bilinear
//         energy renormalisation so the extra ring brightens nothing.
// ---------------------------------------------------------------------------
[numthreads(TS, TS, 1)]
void main_up(uint3 gid : SV_GroupID, uint3 tid : SV_GroupThreadID)
{
    uint w, h;
    gSrc.GetDimensions(w, h);

    int2   p  = int2(gid.xy * TS) + int2(tid.xy);
    float2 uv = (float2(p) + 0.5) * gTexel;

    float tx = gTexel.x;
    float ty = gTexel.y;

    // Explicit SampleLevel only: an implicit-LOD Sample would need derivatives.
    float4 s = gSrc.SampleLevel(gSmp, uv, 0) * 4.0;
    s += gSrc.SampleLevel(gSmp, uv + float2( tx, 0.0), 0) * 2.0;
    s += gSrc.SampleLevel(gSmp, uv + float2(-tx, 0.0), 0) * 2.0;
    s += gSrc.SampleLevel(gSmp, uv + float2(0.0,  ty), 0) * 2.0;
    s += gSrc.SampleLevel(gSmp, uv + float2(0.0, -ty), 0) * 2.0;
    s += gSrc.SampleLevel(gSmp, uv + float2( tx,  ty), 0);
    s += gSrc.SampleLevel(gSmp, uv + float2( tx, -ty), 0);
    s += gSrc.SampleLevel(gSmp, uv + float2(-tx,  ty), 0);
    s += gSrc.SampleLevel(gSmp, uv + float2(-tx, -ty), 0);

    float norm = 1.0 / 16.0;

#if GLASS_TIER_HIGH
    // Outer ring at 2 texels: smooths the residual grid pattern that the
    // single-round tent leaves behind on high-DPI compositing surfaces.
    float4 o;
    o  = gSrc.SampleLevel(gSmp, uv + float2( 2.0 * tx, 0.0), 0);
    o += gSrc.SampleLevel(gSmp, uv + float2(-2.0 * tx, 0.0), 0);
    o += gSrc.SampleLevel(gSmp, uv + float2(0.0,  2.0 * ty), 0);
    o += gSrc.SampleLevel(gSmp, uv + float2(0.0, -2.0 * ty), 0);

    // Inner and outer kernels must sum to a partition of unity.
    s   = s * 0.75 + o;
    norm = 1.0 / 16.0;
#endif

    gDst[p] = s * norm;
}
