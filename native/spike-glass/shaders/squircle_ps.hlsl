// squircle_ps.hlsl —— P09 玻璃面板圆角(超椭圆)覆盖率，ps_5_0
//
// 两档实现，用两个 entry point 区分（便于量化对比）：
//   main : 精确档，pow(x,n) 形式，通用 n，代价高
//   poly : 近似档，固定 n≈4 时 x^4+y^4 = (x^2+y^2)^2 - 2x^2y^2，四次根用两次 rsqrt 代替 pow
// 两档输出完全相同语义：返回预乘 alpha 的玻璃色。

cbuffer GlassParams : register(b0)
{
    float4 gRect;    // xy = 面板中心(px), zw = 半宽/半高(px)
    float4 gParams;  // x = cornerRadius, y = 超椭圆指数 n, z = 边缘软化(px), w = 不透明度
};

Texture2D<float4> gMask : register(t0);
SamplerState      gSmp  : register(s0);

struct PSIn
{
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

// 归一化到半径坐标系：q=1 恰好在圆角边界上
float2 ToCornerSpace(float2 uv)
{
    float2 p = uv * 2.0 - 1.0;
    return p * (gRect.zw / max(gParams.x, 1e-3));
}

// 精确档：|x|^n + |y|^n 的 n 次根，4 次 pow
float SdSuperellipseExact(float2 q, float n)
{
    float2 a = abs(q);
    float k = pow(a.x, n) + pow(a.y, n);
    return pow(k, rcp(n));
}

// 近似档：以 n=4 为准，完全用 mad/rsqrt 展开，零 pow
float SdSuperellipsePoly(float2 q)
{
    float2 a = abs(q);
    float2 a2 = a * a;                       // x^2, y^2
    float v = dot(a2, a2) - 2.0 * a2.x * a2.y;  // = x^4 + y^4
    v = max(v, 1e-8);
    return rsqrt(rsqrt(v));                  // v^(1/4)
}

float4 Shade(float2 q, float d, float2 uv)
{
    float aa  = max(fwidth(d) * gParams.z, 1e-4);
    float cov = saturate((1.0 - d) / aa);    // d<=1 在内部
    cov = saturate(cov);
    float4 tint = gMask.SampleLevel(gSmp, uv, 0);
    return float4(tint.rgb, tint.a * cov * gParams.w);
}

float4 main(PSIn i) : SV_Target
{
    float2 q = ToCornerSpace(i.uv);
    float  d = SdSuperellipseExact(q, max(gParams.y, 2.0));
    return Shade(q, d, i.uv);
}

float4 poly(PSIn i) : SV_Target
{
    float2 q = ToCornerSpace(i.uv);
    float  d = SdSuperellipsePoly(q);
    return Shade(q, d, i.uv);
}
