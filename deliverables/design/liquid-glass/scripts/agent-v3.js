/* ============================================================================
   LIGHTWELL V3 · 前沿 Agent 交互与生成式 UI 闭环引擎（scripts/agent-v3.js）
   零虚构对齐：100% 绑定 index.html 真实 DOM 节点与 window.__R77 运行时接口。
   四大闭环能力：
     1. GenerativeUIEngine   —— 对话流内联生成式 UI 卡片 + 展台(.work-plinth) + 参数重采样 SVG 折线图 + R 栏产物同步
     2. PlanningGateEngine   —— 计划板块(#panel-planning)人机回环审批闸门真实步骤推进与只读安全拦截
     3. MemoryWellEngine     —— 记忆板块(#panel-memory)本地库/镜像过滤 + 安全 DOM 高亮下划线(.hit-mark)
     4. McpRackEngine        —— MCP 板块(#panel-mcp)服务器架点击下钻 + 能力注册表(.registry-table)动态切换
   硬边界：零颜色字面量（#hex / rgb() / hsl()），零外部网络请求，零 innerHTML XSS。
   ============================================================================ */
(function () {
  'use strict';

  if (window.LightwellAgentV3) return;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  function bridge() {
    return window.__R77 || window.__R72 || null;
  }

  /* ==========================================================================
     1. GenerativeUIEngine：生成式 UI（A2UI / MCP Apps 交互展台与内联卡片）
     ========================================================================== */
  var GenerativeUIEngine = {
    artifacts: [
      {
        id: 'dep-graph-v3',
        title: '依赖图 · v3',
        meta: '2,840 × 1,920 · SVG',
        summary: '当前选中 · 依赖图 v3 ｜ 展出面积 2 大 1 小，釉牌压在展台边界上',
        points: [108, 92, 112, 62, 78, 44],
        peakLabel: '2.6s'
      },
      {
        id: 'cycle-summary',
        title: '循环引用摘要',
        meta: 'TXT · 3 处',
        summary: '当前选中 · 循环引用摘要 ｜ 定位 config.js ↔ runtime.js 等 3 处闭环依赖',
        points: [118, 104, 96, 84, 68, 52],
        peakLabel: '2.1s'
      },
      {
        id: 'migration-draft',
        title: '迁移建议草案',
        meta: 'MD · 12 段',
        summary: '当前选中 · 迁移建议草案 ｜ 含只读安全校验与渐进式模块解耦步骤',
        points: [102, 88, 94, 70, 58, 38],
        peakLabel: '2.9s'
      }
    ],
    activeIndex: 0,

    init: function () {
      var plinth = $('#panel-generative .work-plinth');
      if (!plinth) return;
      var tiles = $$('.plinth-tile', plinth);
      tiles.forEach(function (tile, idx) {
        tile.setAttribute('tabindex', '0');
        tile.setAttribute('role', 'button');
        tile.setAttribute('aria-pressed', String(idx === 0));
        var activate = function () { GenerativeUIEngine.selectTile(idx); };
        tile.addEventListener('click', activate);
        tile.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
        });
      });

      ['#genTemp', '#genMax', '#genFormat'].forEach(function (sel) {
        var el = $(sel);
        if (!el) return;
        el.addEventListener('change', function () {
          GenerativeUIEngine.recomputeChart();
        });
      });
    },

    selectTile: function (idx) {
      var art = GenerativeUIEngine.artifacts[idx];
      if (!art) return;
      GenerativeUIEngine.activeIndex = idx;
      var plinth = $('#panel-generative .work-plinth');
      var tiles = plinth ? $$('.plinth-tile', plinth) : [];
      tiles.forEach(function (t, i) {
        t.setAttribute('aria-pressed', String(i === idx));
      });
      var enamel = plinth ? $('.plinth-enamel', plinth) : null;
      if (enamel) enamel.textContent = art.summary;
      GenerativeUIEngine.applySeries(art.points, art.peakLabel);
      if (window.LiquidFX && typeof window.LiquidFX.sweep === 'function' && tiles[idx]) {
        window.LiquidFX.sweep(tiles[idx], { peak: 0.65 });
      }
      var R = bridge();
      if (R && R.Toast) R.Toast.show('展台已切换 · ' + art.title, 'ok');
    },

    recomputeChart: function () {
      var tempEl = $('#genTemp');
      var fmtEl = $('#genFormat');
      var t = tempEl ? parseFloat(tempEl.value) : 0.35;
      if (!isFinite(t) || t < 0) t = 0.35;
      if (t > 2) t = 2;
      var base = GenerativeUIEngine.artifacts[GenerativeUIEngine.activeIndex].points;
      var shift = Math.round((t - 0.35) * 24);
      var nextPts = base.map(function (y, i) {
        var v = y - (i % 2 === 0 ? shift : -Math.round(shift * 0.6));
        return Math.max(24, Math.min(126, v));
      });
      var minY = Math.min.apply(null, nextPts);
      var sec = (1.2 + ((138 - minY) / 114) * 1.8).toFixed(1) + 's';
      GenerativeUIEngine.applySeries(nextPts, sec);
      var R = bridge();
      if (R && R.Toast) {
        var fmt = fmtEl ? fmtEl.value : 'SVG 依赖图';
        R.Toast.show('生成式参数已重采样 · 温度 ' + t.toFixed(2) + ' · ' + fmt, 'ok');
      }
    },

    applySeries: function (ys, peakText) {
      var svg = $('#panel-generative .chart-slab svg');
      if (!svg || !ys || ys.length !== 6) return;
      var xs = [36, 90, 144, 198, 252, 306];
      var polyCoords = xs.map(function (x, i) { return x + ',' + ys[i]; }).join(' ');
      var fillCoords = polyCoords + ' 306,138 36,138';
      var line = $('.series-line', svg);
      var fill = $('.series-fill', svg);
      if (line) line.setAttribute('points', polyCoords);
      if (fill) fill.setAttribute('points', fillCoords);
      var dots = $$('.series-dot', svg);
      dots.forEach(function (dot, i) {
        if (ys[i] !== undefined) dot.setAttribute('cy', String(ys[i]));
      });
      var valLabel = $('.value-label', svg);
      if (valLabel && peakText) valLabel.textContent = peakText;
    },

    /* 在对话流中生成可交互的生成式 UI 卡片，并同步推送至 R 栏产物列表 */
    spawnInlineCard: function (promptText) {
      var track = $('#chatTrack');
      if (!track) return;
      var card = document.createElement('div');
      /* 必须带 .gen-inline-card：optics.js 的 SHEEN_SEL 与 main.js 的
         MagneticSheen.SELECTOR 都按这个类名挂磁吸高光；只写 data-gen-ui
         会让卡片拿到样式却拿不到追光。 */
      card.className = 'slab slab--raised gen-inline-card';
      card.setAttribute('data-runtime-msg', '1');
      card.setAttribute('data-gen-ui', '1');

      var head = document.createElement('div');
      head.className = 'code-slab-head';
      var title = document.createElement('span');
      title.textContent = '生成式 UI 视图 · 动态拓扑与调用耗时分布（交互可下钻）';
      var actions = document.createElement('div');
      actions.className = 'approve-pair';

      var openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'copy-btn';
      openBtn.textContent = '在展台打开';
      openBtn.addEventListener('click', function () {
        var R = bridge();
        if (R && R.ViewRouter) R.ViewRouter.switchTo('generative');
      });

      actions.appendChild(openBtn);
      head.appendChild(title);
      head.appendChild(actions);
      card.appendChild(head);

      var note = document.createElement('p');
      note.className = 'mini-note';
      note.textContent = '基于指令「' + String(promptText || '').slice(0, 28) + '」实时合成 · 已同步写入右侧「产物」栏与生成式展台。';
      card.appendChild(note);

      track.appendChild(card);
      GenerativeUIEngine.appendArtifactRow('gen-ui-' + Date.now().toString().slice(-4) + '.svg', '14.2 KB');
    },

    appendArtifactRow: function (filename, sizeLabel) {
      var panel = $('#resPanelArtifact');
      if (!panel) return;
      var row = document.createElement('div');
      row.className = 'res-artifact';
      var nameSpan = document.createElement('span');
      nameSpan.className = 'res-artifact-name';
      nameSpan.textContent = filename;
      var statSpan = document.createElement('span');
      statSpan.className = 'res-file-stat';
      statSpan.textContent = sizeLabel;
      row.appendChild(nameSpan);
      row.appendChild(statSpan);
      var thumbs = $('.res-thumbs', panel);
      if (thumbs) panel.insertBefore(row, thumbs);
      else panel.appendChild(row);
      var R = bridge();
      if (R && R.ResView && typeof R.ResView.renderSheet === 'function') {
        R.ResView.renderSheet();
      }
    }
  };

  /* ==========================================================================
     2. PlanningGateEngine：人机回环审批闸门真实执行推进
     ========================================================================== */
  var PlanningGateEngine = {
    init: function () {
      var approve = $('#approveBtn');
      var reject = $('#rejectBtn');
      if (approve) {
        approve.addEventListener('click', function () {
          PlanningGateEngine.approve();
        });
      }
      if (reject) {
        reject.addEventListener('click', function () {
          PlanningGateEngine.reject();
        });
      }
    },

    approve: function () {
      var R = bridge();
      var steps = $$('#panel-planning .stair-step');
      if (!steps.length) return;

      /* 第 03、04 步推进为已完成 */
      [2, 3].forEach(function (idx) {
        var st = steps[idx];
        if (!st) return;
        st.setAttribute('data-state', 'ok');
        st.removeAttribute('data-ui-state');
        var shape = $('.shape', st);
        if (shape) shape.textContent = '●';
        var spans = $$('span', st);
        if (spans[2]) spans[2].textContent = spans[2].textContent.replace(/·\s*(进行中|待办|已驳回)$/, '· 已完成');
        var elapsed = $('.elapsed', st);
        if (elapsed && elapsed.textContent === '—') elapsed.textContent = '1.1s';
      });

      /* 第 05 步为写入操作：受只读密级门控约束 */
      var step5 = steps[4];
      var readOnly = R && R.AppState ? !!R.AppState.readOnly : true;
      if (step5) {
        if (readOnly) {
          step5.setAttribute('data-state', 'err');
          step5.setAttribute('data-ui-state', 'disabled');
          var s5 = $('.shape', step5);
          if (s5) s5.textContent = '⊘';
          var sp5 = $$('span', step5);
          if (sp5[2]) sp5[2].textContent = '写入本地报告 · 只读已拦截';
        } else {
          step5.setAttribute('data-state', 'ok');
          step5.removeAttribute('data-ui-state');
          step5.removeAttribute('aria-disabled');
          var s5ok = $('.shape', step5);
          if (s5ok) s5ok.textContent = '●';
          var sp5ok = $$('span', step5);
          if (sp5ok[2]) sp5ok[2].textContent = '写入本地报告 · 已完成';
          var el5 = $('.elapsed', step5);
          if (el5) el5.textContent = '0.4s';
        }
      }

      var prog = $('#panel-planning .plan-progress');
      if (prog) prog.textContent = readOnly ? '80%' : '100%';

      if (R && R.CostRibbon && !R.CostRibbon.overBudget()) {
        R.CostRibbon.tick({ name: 'plan_gate_exec', tokens: 320, cost: 0.08 });
      }
    },

    reject: function () {
      var steps = $$('#panel-planning .stair-step');
      var step3 = steps[2];
      if (step3) {
        step3.setAttribute('data-state', 'err');
        var shape = $('.shape', step3);
        if (shape) shape.textContent = '⊘';
        var spans = $$('span', step3);
        if (spans[2]) spans[2].textContent = '标注循环引用 · 已驳回';
      }
      var note = $('#panel-planning .deviation-note');
      if (note) {
        note.textContent = '审批已驳回：执行流已在检查点 03 处安全中止，未产生任何磁盘写入。';
      }
    }
  };

  /* ==========================================================================
     3. MemoryWellEngine：可解释记忆检索井实时过滤与安全 DOM 高亮
     ========================================================================== */
  var MemoryWellEngine = {
    sourceFilter: 'local',

    init: function () {
      var query = $('#memoryQuery');
      var btn = $('#memorySearchBtn');
      var srcBtns = $$('#panel-memory .well-source button');

      srcBtns.forEach(function (b) {
        b.addEventListener('click', function () {
          MemoryWellEngine.sourceFilter = b.getAttribute('data-source') || 'local';
          MemoryWellEngine.filter();
        });
      });

      if (query) {
        query.addEventListener('input', function () {
          MemoryWellEngine.filter();
        });
      }
      if (btn) {
        btn.addEventListener('click', function () {
          MemoryWellEngine.filter();
        });
      }
    },

    filter: function () {
      var query = $('#memoryQuery');
      var q = query ? String(query.value || '').trim().toLowerCase() : '';
      var rows = $$('#panel-memory .hit-stream .hit-row');
      var visible = 0;

      rows.forEach(function (row) {
        var srcEl = $('.hit-source', row);
        var srcText = srcEl ? srcEl.textContent : '';
        var srcMatch = MemoryWellEngine.sourceFilter === 'local'
          ? srcText.indexOf('本地库') >= 0
          : srcText.indexOf('镜像') >= 0;

        var contentDiv = row.children[1];
        var rawText = contentDiv ? contentDiv.textContent : '';
        var qMatch = !q || rawText.toLowerCase().indexOf(q) >= 0;

        /* 初始空查询时同时展示本地库与镜像全量条目，输入查询或点击检索后按当前数据源过滤 */
        var show = q ? (srcMatch && qMatch) : true;
        row.hidden = !show;
        if (show) {
          visible += 1;
          if (contentDiv && q) {
            MemoryWellEngine.highlightSafe(contentDiv, rawText, q);
          }
        }
      });

      var bar = $('#panel-memory .db-status-bar');
      if (bar && bar.firstElementChild) {
        bar.firstElementChild.textContent = q ? ('命中 ' + visible + ' 条') : '条目 2,481';
      }
    },

    /* 纯安全 DOM 构造高亮下划线（零 innerHTML，杜绝 XSS） */
    highlightSafe: function (container, fullText, needle) {
      var lower = fullText.toLowerCase();
      var idx = lower.indexOf(needle);
      if (idx < 0) return;
      container.textContent = '';
      if (idx > 0) {
        container.appendChild(document.createTextNode(fullText.slice(0, idx)));
      }
      var mark = document.createElement('span');
      mark.className = 'hit-mark';
      mark.textContent = fullText.slice(idx, idx + needle.length);
      container.appendChild(mark);
      if (idx + needle.length < fullText.length) {
        container.appendChild(document.createTextNode(fullText.slice(idx + needle.length)));
      }
    }
  };

  /* ==========================================================================
     4. McpRackEngine：MCP 服务器架三层下钻（服务器 → 分页 → 能力表）
     ========================================================================== */
  var McpRackEngine = {
    catalog: {
      filesystem: [
        ['read_file', '2', '8ms', '● 可用'],
        ['list_directory', '1', '6ms', '● 可用'],
        ['search_text', '3', '21ms', '◐ 测试中'],
        ['write_file', '2', '—', '⊘ 只读拦截'],
        ['git_status', '0', '34ms', '● 可用']
      ],
      git: [
        ['git_diff', '2', '19ms', '● 可用'],
        ['git_log', '1', '14ms', '● 可用'],
        ['git_commit', '2', '—', '⊘ 只读拦截']
      ],
      webdav: [],
      sqlite: [],
      redis: [
        ['ping_handshake', '0', '—', '◐ 握手中']
      ]
    },

    init: function () {
      var slats = $$('#panel-mcp .server-rack .server-slat');
      slats.forEach(function (slat) {
        slat.setAttribute('tabindex', '0');
        slat.setAttribute('role', 'button');
        var select = function () { McpRackEngine.selectServer(slat, slats); };
        slat.addEventListener('click', select);
        slat.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select();
          }
        });
      });
    },

    selectServer: function (targetSlat, allSlats) {
      allSlats.forEach(function (s) { s.classList.remove('is-selected'); });
      targetSlat.classList.add('is-selected');
      var label = targetSlat.textContent || '';
      var key = 'filesystem';
      ['filesystem', 'git', 'webdav', 'sqlite', 'redis'].forEach(function (k) {
        if (label.indexOf(k) >= 0) key = k;
      });
      var rows = McpRackEngine.catalog[key] || [];
      var wrap = $('#registryWrap');
      var empty = $('#registryEmpty');
      var tbody = $('#registryWrap .registry-table tbody');

      if (!rows.length) {
        if (wrap) wrap.hidden = true;
        if (empty) empty.hidden = false;
        return;
      }
      if (empty) empty.hidden = true;
      if (wrap) wrap.hidden = false;
      if (tbody) {
        tbody.textContent = '';
        rows.forEach(function (r) {
          var tr = document.createElement('tr');
          r.forEach(function (cell, i) {
            var td = document.createElement('td');
            if (i === 1 || i === 2) td.className = 'num';
            td.textContent = cell;
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
      }
    }
  };

  /* ==========================================================================
     6. ExpertLaneEngine：多智能体编排泳道动态推演（绑定 #panel-expert）
     ========================================================================== */
  var ExpertLaneEngine = {
    init: function () {
      var revalidate = $('#expertRevalidate');
      if (!revalidate) return;
      revalidate.addEventListener('click', function () {
        var dots = $$('#panel-expert .expert-lanes .lane-dot');
        dots.forEach(function (dot) {
          dot.classList.remove('is-warn');
        });
        var nodes = $$('#panel-expert .orchestration-chain .chain-node-card');
        if (nodes[2]) {
          nodes[2].textContent = '审校专家 · 已启用';
        }
      });
    }
  };

  /* ==========================================================================
     7. CollabTelemetryEngine：协作拓扑与实时预算环同步（绑定 #panel-collaboration）
     ========================================================================== */
  var CollabTelemetryEngine = {
    init: function () {
      var syncRing = function () {
        var R = bridge();
        if (!R || !R.AppState) return;
        var used = Number(R.AppState.costYuan) || 0;
        var budget = Number(R.AppState.budgetYuan) || 2.00;
        var remain = Math.max(0, budget - used);
        var pct = Math.max(0, Math.min(100, Math.round((remain / budget) * 100)));
        var fg = $('#panel-collaboration .budget-ring .ring-fg');
        var val = $('#panel-collaboration .budget-ring .ring-value');
        var cap = $('#panel-collaboration .budget-ring .ring-caption');
        if (fg) {
          var dash = Math.round((pct / 100) * 289);
          fg.setAttribute('stroke-dasharray', dash + ' 289');
        }
        if (val) val.textContent = '¥' + remain.toFixed(2);
        if (cap) cap.textContent = '剩余 · ' + pct + '%';
      };

      ['#overBudgetBtn', '#resetBudgetBtn', '#approveBtn'].forEach(function (sel) {
        var btn = $(sel);
        if (btn) btn.addEventListener('click', function () {
          window.setTimeout(syncRing, 60);
        });
      });
      var composer = $('#composer');
      if (composer) {
        composer.addEventListener('submit', function () {
          window.setTimeout(syncRing, 1200);
        });
      }
      syncRing();
    }
  };

  /* ==========================================================================
     5. 意图感知联动与液态弹射动效桥接
     ========================================================================== */
  function bindIntentBridge() {
    var composer = $('#composer');
    var input = $('#userInput');
    if (!composer || !input) return;

    /* 捕获阶段读取即将提交的文本，触发 LiquidFX.sendLaunch 液滴飞行与生成式 UI 意图扩展 */
    composer.addEventListener('submit', function () {
      var val = String(input.value || '').trim();
      if (!val) return;
      if (window.LiquidFX && typeof window.LiquidFX.sendLaunch === 'function') {
        window.LiquidFX.sendLaunch(composer);
      }
      if (/生成|图表|依赖图|拓扑|svg|chart|ui/i.test(val)) {
        window.setTimeout(function () {
          GenerativeUIEngine.spawnInlineCard(val);
        }, 980);
      }
    }, true);
  }

  function bootV3() {
    GenerativeUIEngine.init();
    PlanningGateEngine.init();
    MemoryWellEngine.init();
    McpRackEngine.init();
    ExpertLaneEngine.init();
    CollabTelemetryEngine.init();
    bindIntentBridge();

    window.LightwellAgentV3 = {
      version: 'v3',
      GenerativeUIEngine: GenerativeUIEngine,
      PlanningGateEngine: PlanningGateEngine,
      MemoryWellEngine: MemoryWellEngine,
      McpRackEngine: McpRackEngine,
      ExpertLaneEngine: ExpertLaneEngine,
      CollabTelemetryEngine: CollabTelemetryEngine
    };
    if (window.__R77) window.__R77.AgentV3 = window.LightwellAgentV3;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootV3, { once: true });
  } else {
    bootV3();
  }
})();
