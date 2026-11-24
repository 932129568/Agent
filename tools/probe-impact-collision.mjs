/* I28 · 关子页「弹回撞钮」四要素实测
 * 判据（手册 I28 的核心场景）：关闭子页面 → 卡片飞出 → 撞到触发钮 → 大外壳偏心余震 + 边缘闪光。
 * 四要素必须**在动画期间**同时出现，缺一即不算：
 *   ① .main 带 kin-impact-*（边缘闪光，靠 ::after）
 *   ② 触发钮带 kin-ring-hit（接触光纹）
 *   ③ #mainStage 的 computed transform 真位移（偏心余震）
 *   ④ onHidden 回调被调用（关闭确实完成）
 * 注意：撞击在 flyMs*0.84 才触发，采样窗口必须 ≥900ms —— 采 8 帧会得到"没动"的假结论。
 * 运行：node tools/probe-impact-collision.mjs
 */
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
const ROOT='C:/v4h/proj'
const require=createRequire(pathToFileURL(path.join(ROOT,'server','package.json')).href)
const { chromium }=require('playwright-core')
const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
const b=await chromium.launch({channel:'msedge',headless:true,env,args:['--allow-file-access-from-files']})
const p=await b.newPage({viewport:{width:1280,height:860}})
const errs=[]; p.on('pageerror',e=>errs.push(e.message))
await p.goto(pathToFileURL(path.join(ROOT,'harbor.html')).href,{waitUntil:'load',timeout:30000})
await p.waitForTimeout(6500)
console.log(JSON.stringify(await p.evaluate(async()=>{
  const o={}
  const rig=window['HarborKineticRig']
  const stage=document.getElementById('mainStage')
  const main=document.querySelector('.main')
  // 造一张卡片（带 animate）+ 一个 overlay + 一个触发钮
  const overlay=document.createElement('div'); overlay.className='tmp-ov'
  const card=document.createElement('div'); card.className='tmp-card'
  card.style.cssText='position:fixed;left:200px;top:200px;width:120px;height:80px'
  const trig=document.createElement('button'); trig.id='tmpTrig'
  document.body.append(overlay,card,trig)
  const beforeStage=getComputedStyle(stage).transform
  let hidden=false
  rig.closeWithCollision(overlay, card, trig, ()=>{ hidden=true })
  // 撞击在 flyMs*0.84 才触发（约 300~500ms），必须采样足够长
  const xs=[]; let sawClass=false, sawRing=false
  const t0=performance.now()
  while(performance.now()-t0 < 900){
    await new Promise(r=>requestAnimationFrame(r))
    const t=getComputedStyle(stage).transform
    const m=t.match(/matrix3d\(([^)]+)\)/)||t.match(/matrix\(([^)]+)\)/)
    if(m){ const v=m[1].split(',').map(Number); xs.push(v.length>12?v[12]:v[4]) }
    if(/kin-impact-(left|right|top|bottom)/.test(main.className)) sawClass=true
    if(trig.classList.contains('kin-ring-hit')) sawRing=true
  }
  o.sawClassDuring=sawClass; o.sawRingDuring=sawRing
  o.stageMoved = xs.some(v=>Math.abs(v)>0.3)
  o.maxX = xs.length?Math.round(Math.max(...xs.map(Math.abs))*100)/100:0
  o.mainImpactClass = /kin-impact-(left|right|top|bottom)/.test(main.className)
  o.cardAnims = card.getAnimations().length
  o.triggerRing = trig.classList.contains('kin-ring-hit')
  await new Promise(r=>setTimeout(r,700))
  o.onHidden = hidden
  overlay.remove(); card.remove(); trig.remove()
  return o
}),null,1))
console.log('errs',errs.slice(0,2))
await b.close()
