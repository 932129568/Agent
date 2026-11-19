/**
 * R80 / W2 —— 契约 §0 归到我名下的 `scripts/wallpaper.js`（设计稿侧壁纸供给端）。
 *
 * ## 分工（先说清楚，避免和三处已落地的实现打架）
 * - **默认值**由 `styles/tokens.css` 的 `--wp-url / --wp-visible / --wp-x / --wp-y /
 *   --wp-size` 提供（W5 名下，指向 `../assets/wallpaper.jpg` 这张替身图）；
 * - **消费者**由 `styles/views.css` 的 `#desktopMirror` 负责（W1 名下：fixed 铺满、
 *   `background-image: var(--wp-url)`、`opacity: var(--wp-visible)`）;
 * - **本体**（真壁纸）由 `electron/wallpaper.js` + `electron/preload.js` 在主进程读、
 *   经 `harbor:wp` 推给渲染进程（W2 生产链路，见 electron/ 目录）。
 *
 * 所以本脚本在默认情形下**什么都不做**——因为一写就会盖掉上面那些正确值。
 * 它的价值只有两个，且都必须显式触发：
 *   ① 预览时临时换一张壁纸：`index.html#wp=xxx.jpg`（file:// 可用）或
 *      `index.html?wp=xxx.jpg`（http 静态服务）；控制台 `HarborWallpaper.setSource()`；
 *   ② 需要自动发现时把 AUTO_DISCOVER 打开（见下）。
 *
 * ## 为什么默认零探测（实测结论，别改回去）
 * 图像探测只能靠 `new Image().src`，而**探测失败是浏览器网络层打的日志**
 * （Chromium: `Failed to load resource: net::ERR_FILE_NOT_FOUND`），`img.onerror`
 * 只能阻止 Promise reject，**阻止不了那条 console error**。实测 6 个候选全不存在
 * 时 = 控制台 +6 条红字，而视觉收益为 0。默认不探测 ⇒ 控制台绝对干净。
 *
 * ⚠ 路径基准不一样，很容易踩：
 *   - 令牌里的 `url("../assets/wallpaper.jpg")` 是**相对 styles/tokens.css** 解析
 *     → `liquid-glass/assets/wallpaper.jpg`；
 *   - 本脚本 `#wp=` 的值是**相对 index.html** 解析 → 同一个文件要写
 *     `#wp=assets/wallpaper.jpg`（少一层 `../`）。
 * 实测把令牌里那串直接抄进 `#wp=` 会多退一层、指向不存在的路径 → 降级为不可见。
 *
 * 另注：`?wp=` 在 file:// 下会被 Chromium 判加载失败（ERR_FAILED），片段 `#wp=`
 * 才是 file:// 下的正解；两种都支持，脚本按 query → hash 顺序取。
 *
 * ## Electron 下必须让位
 * `window.HARBOR_WP` 存在说明 preload 已接管（主进程读的是真壁纸），本脚本一个
 * 变量都不写，否则会和 preload 的内联 style 抢同一个属性。
 */
(function () {
  'use strict'

  /** 默认关闭自动发现（见文件头「为什么默认零探测」）。 */
  var AUTO_DISCOVER = false

  /** 自动发现时探测的唯一候选——只留一个，把「失败最多 1 条日志」也堵住。 */
  var CANDIDATE = 'wallpaper.jpg'

  // 幂等：重复引入只跑一次
  if (window.HarborWallpaper) return

  // ① Electron：preload 已接管，完全让位（连读都不读）
  if (window.HARBOR_WP) {
    window.HarborWallpaper = {
      mode: 'electron',
      setSource: function () { /* Electron 下由主进程决定，这里不接管 */ },
      current: function () { return '' },
    }
    return
  }

  var root = document.documentElement
  var current = ''

  /** 落值：只在确认图片可解码之后调用，避免闪一下坏图 */
  function apply(url) {
    current = url
    if (!root) return
    root.style.setProperty('--wp-url', 'url("' + url + '")')
    root.style.setProperty('--wp-visible', '1')
    root.dataset.wp = 'ready'
  }

  /** 显式请求失败时退回不可见（这是用户主动要的图不存在，必须让他看出来） */
  function clear() {
    current = ''
    if (!root) return
    root.style.setProperty('--wp-url', 'none')
    root.style.setProperty('--wp-visible', '0')
    root.dataset.wp = 'none'
  }

  /**
   * 探测单张图：能 decode 才算数。注意失败会在控制台留一条浏览器级 error，
   * 所以只在「用户显式指定」或 AUTO_DISCOVER 打开时才调用。
   * @param {string} url
   * @returns {Promise<string>}
   */
  function probe(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image()
      img.onload = function () {
        if (!img.naturalWidth || !img.naturalHeight) { reject(new Error('empty image')); return }
        resolve(url)
      }
      img.onerror = function () { reject(new Error('load failed: ' + url)) }
      img.src = url
    })
  }

  /**
   * 手动指定壁纸源（控制台热换 / 显式传参用）。
   * @param {string} url
   * @returns {Promise<boolean>}
   */
  async function setSource(url) {
    var hit = null
    if (url) {
      try { hit = await probe(String(url)) } catch (error) { hit = null }
    }
    if (hit) apply(hit)
    else clear()
    return !!hit
  }

  /**
   * 读取显式指定的壁纸源：先 query（http 服务），再 hash（file:// 直开）。
   * @returns {string}
   */
  function sourceOverride() {
    try {
      var fromQuery = new URLSearchParams(location.search).get('wp')
      if (fromQuery) return fromQuery
    } catch (error) { /* 环境无 URLSearchParams：落到 hash 分支 */ }
    try {
      var hash = String(location.hash || '').replace(/^#/, '')
      if (!hash) return ''
      return new URLSearchParams(hash).get('wp') || ''
    } catch (error) {
      return ''
    }
  }

  async function boot() {
    var override = sourceOverride()

    // 显式指定：探这一个，失败即降级（用户主动要的，允许留一条日志）
    if (override) {
      await setSource(override)
      return
    }

    // 默认路径：一律不写。令牌已经给了正确的默认值（含替身图），
    // 这里任何一次写入都会盖掉它 —— 这才是「零副作用」的定义。
    if (!AUTO_DISCOVER) return

    var hit = null
    try { hit = await probe(CANDIDATE) } catch (error) { hit = null }
    if (hit) apply(hit)
    else clear()
  }

  window.HarborWallpaper = {
    mode: 'preview',
    setSource: setSource,
    current: function () { return current },
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})()
