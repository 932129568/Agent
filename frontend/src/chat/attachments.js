/* ================= 附件 ================= */
/** 修复 S24：Uint8Array 块拼接（流式解压的 parts 合并；仅用于 ≤2MB 的单文件） */
function _concatU8(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
async function readAttachmentText(f) {
  const buf = new Uint8Array(await f.arrayBuffer());
  // 复核修正：NUL 字节检测——二进制文件（.exe/.dll 等被拖入 text 分支时）
  // 解码出的乱码直入模型上下文（UTF-16/宽字符编码必含 0x00）
  for (let i = 0; i < Math.min(buf.length, 8192); i++) {
    if (buf[i] === 0) throw new Error('检测到二进制内容（含 NUL 字节），已拒绝作为文本读取');
  }
  for (const enc of ['utf-8', 'gbk']) {
    try { return new TextDecoder(enc, { fatal: true }).decode(buf); } catch (e) {}
  }
  return new TextDecoder().decode(buf);
}
function attachmentsAllowed() {
  const mode = document.getElementById('toolMode');
  return !mode || !mode.value || mode.value === 'full';
}
function attachmentsDeniedText() {
  const mode = document.getElementById('toolMode');
  return mode && mode.value === 'off'
    ? '纯聊天模式不会读取本地附件。需要附件请切换「完整」工具权限。'
    : '只读模式不允许新增本地附件。需要附件请切换「完整」工具权限。';
}
async function handleFiles(fileList, type) {
  if (!attachmentsAllowed()) {
    toast(attachmentsDeniedText(), 'warn');
    return false;
  }
  const files = Array.from(fileList);
  for (const f of files) {
    try {
      if (type === 'image') {
        if (f.size > 20*1024*1024) { toast(`图片 ${f.name} 超过 20MB，已跳过`, 'warn'); continue; }
        attachments.push({ type: 'image', dataUrl: await compressImage(await fileToDataURL(f)), name: f.name, size: f.size });
      } else if (type === 'video') {
        if (f.size > 10*1024*1024) { toast(`视频 ${f.name} 超过 10MB 已拦截：视频按 token 计费极高且多轮任务会整发重发，请改用截图或文字描述关键内容。`, 'warn'); continue; }
        attachments.push({ type: 'video', dataUrl: await fileToDataURL(f), name: f.name, size: f.size });
      } else if (type === 'text') {
        if (f.size > 20*1024*1024) { toast(`文本 ${f.name} 超过 20MB，已跳过`, 'warn'); continue; }
        try { attachments.push({ type: 'text', text: await readAttachmentText(f), name: f.name }); }
        catch (e) { toast(`读取 ${f.name} 失败: ${e.message}`, 'err'); }
      } else if (type === 'zip') {
        if (f.size > 50*1024*1024) { toast(`压缩包 ${f.name} 超过 50MB：全量解压内存峰值可达数 GB 会假死，更大的包请解压后按需选取文本文件。`, 'warn'); continue; }
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          // 修复 W31：zip 白名单移出 .env/.reg/.properties（密钥/注册表/凭据文件不再直发云端）
          const textExts = ['.txt','.md','.markdown','.json','.csv','.log','.srt','.py','.js','.ts','.html','.css','.java','.c','.cpp','.h','.hpp','.cs','.go','.rs','.yaml','.yml','.xml','.ini','.conf','.sh','.bat','.sql','.tex','.jsx','.vue','.php','.rb','.lua','.swift','.kt','.dart','.toml','.ps1','.vbs','.ahk','.gradle','.cfg','.makefile'];
          const binaryExts = ['.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico','.exe','.dll','.bin','.so','.dylib','.zip','.rar','.7z','.tar','.gz','.pdf','.mp3','.wav','.mp4','.avi','.mov','.mkv','.woff','.woff2','.ttf','.otf','.eot','.class','.jar','.pyc','.db','.sqlite','.pak'];
          // 修复 S24：flate.Unzip 流式解压——按文件回调渐进处理，累计解压量超 200MB 即中止
          //（原 unzipSync 一次性全量解压进内存，高压缩率 zip bomb 可解到数 GB，防线全部在解压之后）。
          // 不需要的文件不调 start() → 完全不解压；文本文件按块接收，单文件超 2MB 即丢弃。
          // 中止方式：ondata 里只置标志（fflate 内部 try/catch 会吞掉回调抛出的异常），
          // 由外层分块喂入循环检测标志后停止 push。
          const ZIP_TOTAL_CAP = 200 * 1024 * 1024;
          const ZIP_FEED_CHUNK = 1024 * 1024;   // 1MB 分块喂入，给中止检查留检查点
          let zipTotalOut = 0;
          let zipOverCap = false;
          const entries = [];
          const uz = new flate.Unzip((file) => {
            const lower = String(file.name || '').toLowerCase();
            if (binaryExts.some(ext => lower.endsWith(ext))) return;         // 二进制后缀：不解压
            const base = lower.split('/').pop();
            const isText = textExts.some(ext => lower.endsWith(ext)) || !base.includes('.');
            if (!isText) return;                                             // 未知后缀：不解压
            if ((file.originalSize || 0) > 2*1024*1024) return;              // 头部声明超 2MB：不解压（与原单文件上限一致）
            const parts = [];
            let got = 0; let dropped = false;
            file.ondata = (err, dat, final) => {
              if (err || !dat) return;
              zipTotalOut += dat.length;
              if (zipTotalOut > ZIP_TOTAL_CAP) { zipOverCap = true; return; }   // 置标志，外层停止喂入
              got += dat.length;
              if (got > 2*1024*1024) { dropped = true; return; }             // 实际超 2MB（头部声明缺失时）：丢弃
              parts.push(dat);
              if (final && !dropped) entries.push({ name: file.name, bytes: _concatU8(parts) });
            };
            file.start();                                                    // 开始流式解压本文件
          });
          for (let off = 0; off < buf.length && !zipOverCap; off += ZIP_FEED_CHUNK) {
            uz.push(buf.subarray(off, Math.min(off + ZIP_FEED_CHUNK, buf.length)), false);
          }
          if (zipOverCap) throw new Error('解压总量超 200MB 上限，已中止（疑似压缩炸弹）');
          uz.push(new Uint8Array(0), true);   // 收尾（EOCD 校验由 fflate 完成）
          let combined = '';
          let fileCount = 0;
          for (const en of entries) {
            let text;
            try { text = new TextDecoder('utf-8', {fatal: true}).decode(en.bytes); }
            catch (e) { try { text = new TextDecoder('gbk').decode(en.bytes); } catch (e2) { text = new TextDecoder().decode(en.bytes); } }
            combined += `\n===== ${en.name} =====\n${text}`;
            fileCount++;
            if (combined.length > 100*1024) { combined = combined.slice(0, 100*1024) + '\n…(内容过长已截断)'; break; }
          }
          if (fileCount === 0) { toast('压缩包里没找到可读取的文本文件', 'warn'); continue; }
          attachments.push({ type: 'text', text: combined, name: `${f.name}（含${fileCount}个文件）` });
        } catch (e) { toast(`解压 ${f.name} 失败: ${e.message || e}`, 'err'); }
      }
    } catch (e) {
      toast('处理 ' + f.name + ' 失败: ' + (e.message || e), 'err');
    }
  }
  renderPreview();
  return true;
}
function removeAttachment(i) { attachments.splice(i, 1); renderPreview(); }
/* v4：附件条三态——0→n 整条 show（退场走 hiding 显隐模式）；
   n→n+1 只给新增项加 .enter（animationend 移除，历史项不重播）；
   n→0 加 .hiding，动画结束（MOTION.onAnimEnd 双兜底）后移除 .show/.hiding 并清空 */
let _attachCount = 0;
function renderPreview() {
  const box = document.getElementById('attachPreview');
  if (!box) return;   // null 守卫：容器不存在（vm 沙箱/未挂载）时静默跳过
  const n = attachments.length;
  if (n === 0) {
    if (_attachCount > 0 && box.classList.contains('show') && !box.classList.contains('hiding')) {
      box.classList.add('hiding');
      const done = () => {
        // 退场竞态复核：动画期间又有附件加入（renderPreview 已清 hiding 并重填），
        // 不得把 show 剥掉/把新内容清空（菜单「开了却看不见」同款事故）
        if (!box.classList.contains('hiding')) return;
        try {
          box.classList.remove('show', 'hiding');
          if (attachments.length === 0) box.innerHTML = '';   // 仅计数为 0 才清空
        } catch (e) {}
      };
      if (typeof MOTION !== 'undefined' && !MOTION.instant()) {
        MOTION.onAnimEnd(box, 'animationend', MOTION.compOut()).then(done);
      } else { done(); }
    } else if (!box.classList.contains('hiding')) {
      try { box.classList.remove('show'); box.innerHTML = ''; } catch (e) {}
    }
    _attachCount = 0;
    return;
  }
  const firstShow = _attachCount === 0;
  box.innerHTML = '';
  attachments.forEach((a, i) => {
    const div = document.createElement('div');
    div.className = 'attach-item';
    if (a.type === 'image') div.innerHTML = `<img src="${a.dataUrl}"><button class="remove" aria-label="移除附件" onclick="removeAttachment(${i})"><svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-close"/></svg></button>`;
    else if (a.type === 'video') div.innerHTML = `<div class="file-icon">🎬<span>${escapeHtml(a.name.slice(0, 8))}</span></div><button class="remove" aria-label="移除附件" onclick="removeAttachment(${i})"><svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-close"/></svg></button>`;
    else div.innerHTML = `<div class="file-icon">📄<span>${escapeHtml(a.name.slice(0, 8))}</span></div><button class="remove" aria-label="移除附件" onclick="removeAttachment(${i})"><svg class="ui-icon ui-icon-16" aria-hidden="true"><use href="#i-close"/></svg></button>`;
    // 增量入场：仅本次新增的项播 .enter
    if (!firstShow && i >= _attachCount) {
      div.classList.add('enter');
      if (typeof MOTION !== 'undefined' && !MOTION.instant()) {
        MOTION.onAnimEnd(div, 'animationend', MOTION.comp()).then(() => { try { div.classList.remove('enter'); } catch (e) {} });
      } else { try { div.classList.remove('enter'); } catch (e) {} }
    }
    box.appendChild(div);
  });
  // 重入场（刚退场又新增）：清退场态并强制 reflow，v4AttachIn 从头播放
  if (box.classList.contains('hiding')) { box.classList.remove('hiding'); void box.offsetWidth; }
  box.classList.add('show');
  _attachCount = n;
}
