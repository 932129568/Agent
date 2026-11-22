// squircle_ps.hlsl -- Harbor glass panel, squircle coverage + refraction, ps_5_0
//
// MACRO-LEVEL DUAL TIER: ONE source file, TWO compile passes selected by -D.
//   LOW  pass: fxc /T ps_5_0 /E main
//   HIGH pass: fxc /T ps_5_0 /E main /DGLASS_TIER_HIGH=1
//
// The two tiers must differ by >= 8 shader instructions (enforced by
// shaders/verify_tiers.py). The LOW body lives in ShadeLow(); every optical
// feature below is HIGH-only and is layered on top of it:
//   (1) chromatic dispersion      -- R/G/B sampled with three different IORs
//   (2) secondary refraction fix  -- SDF + normal re-evaluated at the bent uv
//   (3) edge Fresnel falloff      -- grazing-angle highlight on the rim
//
// The legacy entry point "poly" is kept so the untouched M1 regression
// baseline (native/build-shaders.bat) keeps compiling; it always emits the
// LOW path regardless of the macro.
//
// This file is consumed by fxc, not by cmd.exe, so its comments may be
// non-ASCII; the .bat driver must stay ASCII. Comments here are kept ASCII
// anyway so the sources stay byte-stable across editors.
//
// NOTE: NO derivatives are allowed in the compute shader; this PS file is
// allowed to use fwidth() because pixel shaders evaluate derivatives per quad.

// NOTE: test with #if, never #ifdef. The guard below defines the macro to 0
// when absent, so #ifdef would be true in BOTH passes and the two "tiers"
// would silently compile to identical code -- the exact fake-dual-tier bug
// this task exists to kill.
#ifndef GLASS_TIER_HIGH
#define GLASS_TIER_HIGH 0
#endif

cbuffer GlassParams : register(b0)
{
    float4 gRect;     // xy = panel center(px), zw = half size(px)
    float4 gParams;   // x = cornerRadius, y = frost, z = edgeSoftness(px), w = opacity
    float4 gOptics;   // x = ior, y = dispersion, z = refractScale, w = fresnelPower
};

Texture2D<float4> gMask  : register(t0);   // squircle alpha mask / tint
Texture2D<float4> gScene : register(t1);   // backdrop that gets refracted
SamplerState      gSmp   : register(s0);

struct PSIn
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

// ---------------------------------------------------------------------------
// Superellipse (n = 4, "squircle") signed distance, zero pow() calls.
// x^4 + y^4 = (x^2+y^2)^2 - 2*x^2*y^2, and the 4th root is rsqrt(rsqrt()).
// ---------------------------------------------------------------------------
float2 AbsSq(float2 q)
{
    float2 a = abs(q);
    return a * a;                                  // (x^2, y^2)
}

float SdSquircle(float2 q)
{
    float2 a2 = AbsSq(q);
    float  v  = dot(a2, a2) - 2.0 * a2.x * a2.y;    // x^4 + y^4
    return rsqrt(rsqrt(max(v, 1e-8)));              // v^(1/4)
}

// Analytic outward normal: grad(x^4 + y^4) = 4 * (x^3, y^3).
// a2 * q keeps the sign of q while giving |q|^2 * q = q^3.
float2 SdNormal(float2 q)
{
    float2 a2 = AbsSq(q);
    float2 g  = a2 * q;
    return normalize(g + float2(1e-6, 1e-6));
}

// Panel-local coordinates: |q| == 1 lies exactly on the corner arc.
float2 ToCornerSpace(float2 uv)
{
    return (uv * 2.0 - 1.0) * (gRect.zw / max(gParams.x, 1e-3));
}

// Single-tap refraction approximation shared by both tiers.
// LOW uses it once; HIGH uses it three times (one per color channel) plus a
// second pass to correct the displacement.
float2 RefractUv(float2 uv, float2 n, float ior)
{
    float k = (1.0 - rcp(max(ior, 1.0))) * gOptics.z * gParams.y;
    return uv + n * k;
}

// ---------------------------------------------------------------------------
// LOW tier body: one SDF evaluation, one normal, one refraction tap.
// ---------------------------------------------------------------------------
float4 ShadeLow(PSIn i)
{
    float2 q   = ToCornerSpace(i.uv);
    float  d   = SdSquircle(q);
    float2 n   = SdNormal(q);

    // Analytic-ish AA: derivatives of the SDF give coverage in one shot.
    float  aa  = max(fwidth(d) * gParams.z, 1e-4);
    float  cov = saturate((1.0 - d) / aa);

    float  ior = max(gOptics.x, 1.0);
    float2 ruv = RefractUv(i.uv, n, ior);
    float4 rgb = gScene.SampleLevel(gSmp, ruv, 0);

    float4 tint = gMask.SampleLevel(gSmp, i.uv, 0);
    return float4(rgb.rgb * tint.rgb, tint.a * cov * gParams.w);
}

// ---------------------------------------------------------------------------
// Entry point. The #if below is the whole tiering mechanism: LOW resolves
// to exactly ShadeLow(), HIGH layers the three optical features on top.
// ---------------------------------------------------------------------------
float4 main(PSIn i) : SV_Target
{
#if GLASS_TIER_HIGH
    float4 base = ShadeLow(i);

    float2 q    = ToCornerSpace(i.uv);
    float2 n    = SdNormal(q);
    float  ior  = max(gOptics.x, 1.0);

    // (1) Chromatic dispersion: three IORs fan the backdrop into a spectrum.
    float2 ruvR = RefractUv(i.uv, n, ior * (1.0 - gOptics.y));
    float2 ruvB = RefractUv(i.uv, n, ior * (1.0 + gOptics.y));
    float4 disp = base;
    disp.r = gScene.SampleLevel(gSmp, ruvR, 0).r;
    disp.b = gScene.SampleLevel(gSmp, ruvB, 0).b;

    // (2) Secondary refraction: the first bend lands on a different part of
    //     the lens, so the SDF and normal must be re-evaluated there.
    float2 bend = RefractUv(i.uv, n, ior);
    float2 q2   = ToCornerSpace(bend);
    float  d2   = SdSquircle(q2);
    float2 n2   = SdNormal(q2);
    float2 ruv2 = RefractUv(bend, n2, ior);
    float  w2   = saturate(0.25 + 0.5 * d2);
    disp.rgb    = lerp(disp.rgb, gScene.SampleLevel(gSmp, ruv2, 0).rgb, w2);

    // (3) Edge Fresnel: grazing angles pick up a rim highlight.
    float ndv  = saturate(dot(n, float2(0.0, 1.0)));
    float fres = pow(1.0 - ndv, max(gOptics.w, 1.0));
    disp.rgb   = disp.rgb + fres * gParams.w * 0.5;

    return disp;
#else
    return ShadeLow(i);
#endif
}

// Legacy alias for the M1 regression baseline (native/build-shaders.bat uses
// /E poly). Pinned to the LOW path so the baseline stays comparable.
float4 poly(PSIn i) : SV_Target
{
    return ShadeLow(i);
}
