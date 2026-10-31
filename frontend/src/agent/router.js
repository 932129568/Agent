/* 实现 v1.6 T5②：EFFICIENCY_PROMPT 增补两条——GitHub Models/免费层限额策略
 * （RPM/RPD 敏感：合并轮次、禁全库扫描）+ MCP 工具铁律（只信最新一条结果）。 */
const EFFICIENCY_PROMPT = `【执行铁律——每条都是为了省 token, 逐条硬性执行】
【读】附件标注"已完整注入"的文件禁止 read_file; 其他文件用 read_file 一次读全(上限2万行/24万字符), 仅当返回带 hint 才按 offset 续读。文件原文一旦进入上下文就保留到会话结束, 严禁重读/复查/跳读确认。严禁用 run_command/run_powershell(type/Get-Content/ReadAllText) 绕路读文件——read_file 一次读全且结果永久保留在上下文，绕路读到的反而被截断。
【答】一条消息里的多个问题合并为一轮处理, 一次性输出全部结果; 工具调用轮次禁止输出任何文字; 最终回复只给结果本身, 不复述任务、不写开场白和总结、不贴大段原文(引用写"文件:行号"), 未改动的代码禁止重复输出。
【改】只改用户指定的文件, 一律 search_replace 打补丁, old 必须与原文逐字符一致(含缩进), 拿不准先 read_file 对应片段再改, 避免试错重试; 无明确要求禁止新建任何文件, 确需新建时 write_file 一次写全。
【轮】读类工具能并行就在同一条消息并行发起(写类除外, 串行等上一个返回); 能一轮完成绝不拆多轮; 信息不足时把全部疑问合并成一条一次问清, 禁止挤牙膏式追问。
【验】验证用一条命令+明确判据, 禁止开放式全库扫描; 改完只报一行结论。
【截图】截图画面自动附在下一轮输入, 无需描述; 返回"与上次一致"直接沿用上次分析。
【源】GitHub Models 免费层限额敏感(约 15 RPM/150 RPD): 读类能并行就并行、合并轮次, 禁全库扫描式验证; 429 时按人话提示等待, 禁止原命令重试轰炸。
【MCP】工具结果只信最新一条: 同名工具重复调用以最后一次返回为准, 旧结果过期不引用; 参数不得臆造, 缺参先问清再调。`;

/* ========== 工具精准路由：按问题域筛选，不全量下发 ========== */
const TOOL_DOMAINS = {
    fileR:  ['read_file','list_dir','get_file_info'],
    fileW:  ['write_file','append_file','search_replace','delete_path','move_path','copy_path','make_dir'],
    shell:  ['run_command','run_powershell','run_admin_command'],
    sys:    ['open_app','open_url','take_screenshot','clipboard_read','clipboard_write'],
    proc:   ['list_processes','kill_process'],
    memory: ['append_memory']
};
const ROUTE_HINTS = {
    fileR:  ['文件','文档','附件','目录','文件夹','路径','源码','代码','项目','工程','读取','看看','检查','分析','报告','日志','code','file','read','log'],
    fileW:  ['修改','编辑','写入','保存','替换','删除','重命名','移动','复制','新建','修复','重构','格式化','补丁','改','fix','edit','write','replace','patch'],
    shell:  ['命令','运行','执行','脚本','powershell','cmd','安装','卸载','编译','构建','git','npm','pip','python','node','测试','启动','停止','服务','端口','环境变量','打包','build','run','test'],
    sys:    ['截图','屏幕','剪贴板','粘贴','打开网页','网址','http','浏览器','打开软件','打开应用','打开文件','程序','app','screenshot','clipboard'],
    proc:   ['进程','卡死','卡住','无响应','内存','cpu','占用','任务管理器','结束','杀掉','蓝屏','崩溃','process','kill'],
    memory: ['记住','记忆','长期保存','收藏','remember']
};
const ROUTE_ALWAYS = ['read_more','append_memory'];   // schema 极小，常驻兜底

/* 修复 TOK-4（v1.4）：域邻接表——用过 fileR 极可能要 fileW（读了就改），
   查过进程可能要 shell（杀了要善后）。漏路由的补救成本（LLM 调不到工具→多轮
   补救反噬）远高于多带一个域的工具 schema。 */
const ROUTE_ADJACENT = { fileR: ['fileW'], proc: ['shell'] };

/**
 * 修复 TOK-4（v1.4）：路由输入增强。
 * 原签名 routeTools(text, hasAttach) 只看最后一条 user 消息的关键词——多步任务中
 * LLM 想调用的工具可能因关键词不在首条消息而被裁（漏路由→多轮补救反噬）。
 * 新签名扩展两个输入：
 *   recentTools —— 最近 2 轮已调用的工具名（所在域 + 邻接域纳入路由集）
 *   recentResult —— 最近一条工具结果前 200 字符（参与关键词匹配；含文件
 *                   路径形态时 fileR/fileW 直接入选）
 * 路由集 = 关键词命中域 ∪ 最近调用域 ∪ 邻接域 ∪ ROUTE_ALWAYS。
 * 注意：mcp__ 工具不参与路由裁剪（v1.3 既定，见 60-agent-loop 过滤处 bypass）。
 */
function routeTools(text, hasAttach, recentTools, recentResult) {
    const t = String(text || '').toLowerCase();
    const on = new Set(ROUTE_ALWAYS);
    const addDomain = (dom) => (TOOL_DOMAINS[dom] || []).forEach(n => on.add(n));
    // ① 关键词命中域（原有逻辑不变）
    for (const dom of Object.keys(TOOL_DOMAINS)) {
        const hit = (ROUTE_HINTS[dom] || []).some(k => t.includes(k));
        if (hit || (dom === 'fileR' && hasAttach)) addDomain(dom);
    }
    // ② 最近调用域 + 邻接域（TOK-4）
    for (const name of (recentTools || [])) {
        for (const dom of Object.keys(TOOL_DOMAINS)) {
            if (TOOL_DOMAINS[dom].includes(name)) {
                addDomain(dom);
                (ROUTE_ADJACENT[dom] || []).forEach(addDomain);
                break;
            }
        }
    }
    // ③ 最近工具结果前 200 字符：关键词 + 路径形态（TOK-4）
    if (recentResult) {
        const rt = String(recentResult).slice(0, 200);
        const rtl = rt.toLowerCase();
        for (const dom of Object.keys(TOOL_DOMAINS)) {
            if ((ROUTE_HINTS[dom] || []).some(k => rtl.includes(k))) addDomain(dom);
        }
        // 结果含文件路径（C:\... / /usr/... / ./x.js）→ 读写双域入选
        if (/[a-z]:\\|\\|\/[a-z0-9_.-]{2,}\.[a-z0-9]{1,5}\b|\/[a-z0-9_.-]{2,}\//i.test(rt)) {
            addDomain('fileR'); addDomain('fileW');
        }
    }
    return on;
}
