/* I28 · 10 套碰撞耦合的可观测性验证
 * 判据：每套 coupling 被触发时，目标元素必须真的产生位移（style.transform 变化）。
 * 「注册了但没效果」是本仓反复出现的坑（kinetic-rig 就曾整块无调用方）。
 * 运行：node tools/probe-couplings-i28.mjs
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
  const o={names:kineticCouplings(), fired:{}, observed:{}}
  const kf=window['kinetic'+'Fire']
  for(const n of o.names){
    // 记录目标元素触发前后的 transform，判断是否真的动过
    const cfgEl = document.querySelector(n==='composer-send'||n==='guard-inline'||n==='drop-magnet'
      ? '#chatInputArea .input-inner' : '#mainStage, .main > .panels')
    const before = cfgEl ? (cfgEl.style.transform||'') : '(no-el)'
    kf(n)
    await new Promise(r=>setTimeout(r,40))
    const after = cfgEl ? (cfgEl.style.transform||'') : '(no-el)'
    o.fired[n]=true
    o.observed[n] = (before!==after)
  }
  return o
}),null,1).slice(0,1200))
console.log('errs',errs.slice(0,2))
await b.close()
