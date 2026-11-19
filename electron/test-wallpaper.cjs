/**
 * R80 / W2 一次性自测：壁纸镜像取数 + 偏移换算 + 失败降级。
 *
 * 跑法（必须用 node 27，见 CONTRACT-R2-PARALLEL §1）：
 *   "C:/Users/陈/.workbuddy/binaries/node/versions/node-v27.0.0-alpha.0.0.0-win-x64/node.exe" electron/test-wallpaper.cjs
 *
 * 退出码：全部通过 0，任一失败 1。
 */
'use strict'

const path = require('node:path')
const { readWallpaper, encodeMirrorImage, wallpaperOffset } = require(path.join(__dirname, 'wallpaper.js'))

let failures = 0

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`)
  if (!ok) failures += 1
}

async function main() {
  console.log('node =', process.version, '(' + process.execPath + ')')
  console.log('')

  /* ---------- ① 真读一次壁纸 ---------- */
  console.log('[1] readWallpaper() 真读')
  const wp = await readWallpaper()
  if (!wp) {
    check('读到壁纸', false, '返回 null')
  } else {
    console.log('    source =', wp.source)
    console.log('    bytes  =', wp.bytes)
    console.log('    size   =', wp.width + '×' + wp.height)
    console.log('    style  =', wp.style, ' tile =', wp.tile)
    console.log('    dataUri.length =', wp.dataUri.length)
    console.log('    dataUri.head   =', wp.dataUri.slice(0, 48) + '…')
    check('dataUri 长度 > 100000', wp.dataUri.length > 100000, String(wp.dataUri.length))
    check('dataUri 是 image/* base64', /^data:image\/[a-z+]+;base64,/.test(wp.dataUri))
    check('宽高已解析且合理', Number(wp.width) >= 800 && Number(wp.height) >= 600,
      wp.width + '×' + wp.height)
    check('宽高比接近 16:9', Math.abs(wp.width / wp.height - 16 / 9) < 0.05,
      (wp.width / wp.height).toFixed(4))
    check('style/tile 是数字串', /^\d+$/.test(wp.style) && /^\d+$/.test(wp.tile),
      wp.style + '/' + wp.tile)
  }
  console.log('')

  /* ---------- ② 坐标换算 ---------- */
  console.log('[2] wallpaperOffset() 反向偏移')
  const a = wallpaperOffset({ x: 0, y: 0 }, 1)
  const b = wallpaperOffset({ x: 100, y: 50 }, 1.5)
  const c = wallpaperOffset({ x: -200, y: -120 }, 2)
  const d = wallpaperOffset({ x: 100, y: 50 }, 0)      // 非法缩放比 → 退 1
  console.log('    {0,0} sf=1      →', JSON.stringify(a))
  console.log('    {100,50} sf=1.5 →', JSON.stringify(b))
  console.log('    {-200,-120} sf=2 →', JSON.stringify(c))
  console.log('    {100,50} sf=0   →', JSON.stringify(d))
  check('bounds{0,0} → x=0,y=0', a.x === 0 && a.y === 0)
  check('bounds{100,50} sf=1.5 → x=-150,y=-75', b.x === -150 && b.y === -75, JSON.stringify(b))
  check('bounds{-200,-120} sf=2 → x=400,y=240', c.x === 400 && c.y === 240, JSON.stringify(c))
  check('sf=0 安全退化为 1 → x=-100,y=-50', d.x === -100 && d.y === -50, JSON.stringify(d))
  console.log('')

  /* ---------- ③ 读不到 → null，不抛 ---------- */
  console.log('[3] 读不到壁纸时静默降级')
  let threw = null
  let missing = 'unset'
  try {
    missing = await readWallpaper({
      skipRegistry: true,
      candidates: ['C:/__no_such_dir__/__no_such_wallpaper__.jpg'],
    })
  } catch (error) {
    threw = error
  }
  console.log('    返回值 =', missing)
  console.log('    抛出   =', threw ? threw.message : '(无)')
  check('返回 null', missing === null, String(missing))
  check('未抛异常', threw === null)

  let threwEmpty = null
  let empty = 'unset'
  try {
    empty = await readWallpaper({ skipRegistry: true, candidates: [] })
  } catch (error) {
    threwEmpty = error
  }
  check('空候选列表也返回 null 且不抛', empty === null && threwEmpty === null, String(empty))
  console.log('')

  /* ---------- ④ encodeMirrorImage 在纯 Node 下的守卫 ---------- */
  console.log('[4] encodeMirrorImage() 非 Electron 环境守卫')
  const fake = { dataUri: 'data:image/jpeg;base64,' + 'A'.repeat(3000000), width: 3840, height: 2160 }
  let threwEncode = null
  let encoded = 'unset'
  try {
    encoded = encodeMirrorImage(fake)
  } catch (error) {
    threwEncode = error
  }
  console.log('    未超限输入原样返回 =',
    encodeMirrorImage({ dataUri: 'data:image/jpeg;base64,AAAA', width: 8, height: 8 }).dataUri.length)
  console.log('    超限输入（纯 Node 无 nativeImage）=',
    encoded === fake ? '原样返回' : String(encoded))
  check('小图原样返回（不白跑降采样）',
    encodeMirrorImage({ dataUri: 'x'.repeat(10) }).dataUri.length === 10)
  check('null 输入返回 null', encodeMirrorImage(null) === null)
  check('超限且无 nativeImage 时不抛异常', threwEncode === null)

  console.log('')
  console.log(failures === 0 ? 'ALL PASS' : failures + ' CHECK(S) FAILED')
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch(error => {
  console.error('自测自身崩了：', error)
  process.exitCode = 1
})
