// dsh-skills-manager client 半边。
//
// 职责（单文件）：设置页「模型」下方的「技能」分区（settings.section order 11）——
//   作用域下拉（用户·本机 / 各工作区）+ 技能计数 + 搜索框；
//   「已安装」分组（可管理：模型调用开关、删除、打开目录）+ 「内置」只读分组；
//   技能详情弹窗（描述 / 范围 / 状态 / 文件路径，描述按 Markdown 渲染）；
//   「导入外部 Agent 技能」弹窗（外部目录发现、软链或复制、导入到全局或项目）；
//   「新建」弹窗（生成最小可用技能目录）。
//
// 数据源：同源只读/写入路由 /dsh-skills-manager/*（host 半提供），全部走宿主，不直连文件系统。
// 主题：只用 --dsw-alias-* 令牌，深浅色自动跟随官方主题；类名统一 dsm-* 前缀。

window.__ModuleLoader__.load({
  // 模块 id 必须与包名逐字一致——宿主按包名注册 factory，id 不符会加载失败。
  id: "@bluechonk/dsh-skills-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    const API = "/dsh-skills-manager";

    /* ---------------------------------------------------------------- */
    /* 样式                                                              */
    /* ---------------------------------------------------------------- */

    const CSS = [
      ".dsm-root{display:flex;flex-direction:column;gap:18px;min-width:0;color:var(--dsw-alias-label-primary);font-size:14px}",
      ".dsm-title{font-size:28px;font-weight:700;letter-spacing:-.01em;margin:0;line-height:1.2}",
      // —— 顶部工具条 ——
      ".dsm-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
      ".dsm-scope{position:relative;flex:none}",
      ".dsm-scopeBtn{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;cursor:pointer}",
      ".dsm-scopeBtn:hover{border-color:var(--dsw-alias-border-l2)}",
      ".dsm-divider{width:1px;height:20px;background:var(--dsw-alias-border-l1);flex:none}",
      ".dsm-meta{color:var(--dsw-alias-label-secondary);font-size:13.5px;white-space:nowrap}",
      ".dsm-meta b{font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".dsm-searchWrap{margin-left:auto;position:relative;display:flex;align-items:center;min-width:160px;max-width:340px;flex:1}",
      ".dsm-searchWrap svg{position:absolute;left:10px;pointer-events:none;color:var(--dsw-alias-label-secondary)}",
      ".dsm-search{width:100%;height:34px;padding:0 12px 0 32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;outline:none}",
      ".dsm-search:focus{border-color:var(--dsw-alias-brand-primary)}",
      ".dsm-search::placeholder{color:var(--dsw-alias-label-secondary)}",
      // —— 分组标题 ——
      ".dsm-sectionHead{display:flex;align-items:center;gap:10px}",
      ".dsm-sectionTitle{font-size:15px;font-weight:600}",
      ".dsm-sectionCount{color:var(--dsw-alias-label-secondary);font-weight:400;font-size:13px;margin-left:2px}",
      ".dsm-actions{margin-left:auto;display:flex;align-items:center;gap:8px}",
      ".dsm-iconBtn{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}",
      ".dsm-iconBtn:hover{background:var(--dsw-alias-bg-layer-2)}",
      ".dsm-primary{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font:inherit;font-size:13.5px;font-weight:500;cursor:pointer}",
      ".dsm-primary:disabled{opacity:.5;cursor:not-allowed}",
      // —— 列表 ——
      ".dsm-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}",
      ".dsm-row{display:flex;align-items:center;gap:14px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer}",
      ".dsm-row:last-child{border-bottom:none}",
      ".dsm-row:hover{background:var(--dsw-alias-bg-layer-2)}",
      ".dsm-icon{width:32px;height:32px;flex:none;border-radius:9px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}",
      ".dsm-rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}",
      ".dsm-name{font-size:14.5px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsm-desc{font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsm-badges{display:flex;gap:6px;align-items:center;flex:none}",
      ".dsm-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap}",
      // —— 开关 ——
      ".dsm-switch{position:relative;width:38px;height:22px;flex:none;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;padding:0}",
      ".dsm-switch[data-on=\"true\"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}",
      ".dsm-switchKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-label-primary);transition:transform .15s ease}",
      ".dsm-switch[data-on=\"true\"] .dsm-switchKnob{transform:translateX(16px);background:var(--dsw-alias-bg-base)}",
      ".dsm-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
      ".dsm-trash{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".dsm-trash:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2)}",
      ".dsm-groupTitle{padding:10px 4px 6px;font-size:12.5px;color:var(--dsw-alias-label-secondary);font-weight:600}",
      // —— 下拉菜单 ——
      ".dsm-menu{position:absolute;z-index:40;top:calc(100% + 6px);left:0;min-width:230px;padding:6px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);display:flex;flex-direction:column;gap:2px}",
      ".dsm-menuRight{left:auto;right:0}",
      // 向上展开：弹窗底部的下拉菜单否则会落在弹窗外并被 overflow 裁掉。
      ".dsm-menuUp{top:auto;bottom:calc(100% + 6px)}",
      ".dsm-menuItem{display:flex;align-items:center;gap:10px;padding:8px 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;text-align:left;cursor:pointer;width:100%}",
      ".dsm-menuItem:hover{background:var(--dsw-alias-bg-layer-2)}",
      ".dsm-menuItem span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsm-menuLabel{padding:8px 10px 4px;color:var(--dsw-alias-label-secondary);font-size:12px}",
      // —— 弹窗 ——
      ".dsm-overlay{position:fixed;inset:0;z-index:60;box-sizing:border-box;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent);padding:24px}",
      ".dsm-modal{width:min(680px,100%);max-height:88vh;display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 24px 64px color-mix(in srgb, var(--dsw-alias-label-primary) 28%, transparent);overflow:hidden}",
      ".dsm-modalHead{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".dsm-modalTitle{font-size:15px;font-weight:600}",
      ".dsm-modalBody{padding:16px 18px 20px;overflow:auto;display:flex;flex-direction:column;gap:10px}",
      ".dsm-label{font-size:12.5px;color:var(--dsw-alias-label-secondary)}",
      ".dsm-mdScroll{max-height:210px;overflow:auto;padding-right:6px;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary);word-break:break-word}",
      // —— Markdown 渲染 ——
      ".dsm-md-p{margin:0 0 8px}",
      ".dsm-md-p:last-child{margin-bottom:0}",
      ".dsm-md-h{font-size:14px;font-weight:600;margin:12px 0 6px;line-height:1.4}",
      ".dsm-md-h:first-child{margin-top:0}",
      ".dsm-md-list{margin:0 0 8px;padding-left:20px}",
      ".dsm-md-list li{margin:2px 0}",
      ".dsm-md-quote{margin:0 0 8px;padding:4px 10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
      ".dsm-md-pre{margin:0 0 8px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);overflow:auto;white-space:pre}",
      ".dsm-md-pre code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}",
      ".dsm-md-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2)}",
      ".dsm-md-p a,.dsm-md-list a,.dsm-md-h a,.dsm-md-quote a{color:var(--dsw-alias-brand-primary)}",
      ".dsm-md-hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:10px 0}",
      ".dsm-muted{color:var(--dsw-alias-label-secondary)}",
      ".dsm-twoCol{display:grid;grid-template-columns:1fr 1fr;gap:16px}",
      "@media (max-width:520px){.dsm-twoCol{grid-template-columns:1fr}}",
      ".dsm-value{font-size:13.5px;margin-top:4px}",
      ".dsm-pathRow{display:flex;align-items:center;gap:6px;margin-top:2px;min-width:0}",
      ".dsm-path{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsm-iconBtnSm{width:26px;height:26px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".dsm-iconBtnSm:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}",
      // 文本按钮：图标按钮是 30px 方形，装不下「取消」这类文字
      ".dsm-btnText{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;white-space:nowrap;cursor:pointer}",
      ".dsm-btnText:hover{background:var(--dsw-alias-bg-layer-2)}",
      // —— 导入弹窗 ——
      ".dsm-select{position:relative}",
      ".dsm-selectBtn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}",
      ".dsm-importBody{padding:14px 18px;display:flex;flex-direction:column;gap:10px;overflow:auto}",
      ".dsm-importCard{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:6px;background:var(--dsw-alias-bg-layer-1)}",
      ".dsm-selectAll{display:flex;align-items:center;gap:10px;padding:8px 10px}",
      ".dsm-selCount{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12.5px}",
      ".dsm-sourceRow{display:flex;align-items:center;gap:12px;padding:10px;border-radius:9px;cursor:pointer}",
      ".dsm-sourceRow:hover{background:var(--dsw-alias-bg-layer-2)}",
      ".dsm-sourceMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".dsm-sourceName{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsm-sourcePath{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsm-sourceCount{color:var(--dsw-alias-label-secondary);font-size:12.5px;white-space:nowrap}",
      ".dsm-importFoot{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1)}",
      ".dsm-footLeft{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px}",
      ".dsm-footRight{margin-left:auto;display:flex;align-items:center;gap:8px}",
      // —— 复选框 ——
      ".dsm-check{width:16px;height:16px;flex:none;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}",
      // —— 表单 ——
      ".dsm-field{display:flex;flex-direction:column;gap:6px}",
      ".dsm-input{height:34px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;outline:none}",
      ".dsm-input:focus{border-color:var(--dsw-alias-brand-primary)}",
      ".dsm-textarea{min-height:76px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;outline:none;resize:vertical}",
      ".dsm-textarea:focus{border-color:var(--dsw-alias-brand-primary)}",
      ".dsm-error{color:var(--dsw-alias-state-error-primary);font-size:12.5px}",
      ".dsm-state{padding:28px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13.5px}",
      ".dsm-footNote{margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}",
    ].join("");

    /** 注入样式（按 data-plugin-css 去重，热重载原位替换）。 */
    function ensureStyles() {
      if (typeof document === "undefined") return;
      // id 用包名：避免与其它插件的 data-plugin-css 撞名互相覆盖。
      const id = "@bluechonk/dsh-skills-manager";
      let style = document.querySelector('style[data-plugin-css="' + id + '"]');
      if (!style) {
        style = document.createElement("style");
        style.setAttribute("data-plugin-css", id);
        document.head.appendChild(style);
      }
      if (style.textContent !== CSS) style.textContent = CSS;
    }

    /* ---------------------------------------------------------------- */
    /* 图标（自绘线性图标，随主题着色）                                     */
    /* ---------------------------------------------------------------- */

    const Svg = (props) => h("svg", Object.assign({ width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }, props));

    const IconMonitor = (p) => h(Svg, p, h("rect", { x: 3, y: 4, width: 18, height: 13, rx: 2 }), h("path", { d: "M8 21h8M12 17v4" }));
    const IconFolder = (p) => h(Svg, p, h("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }));
    const IconCaret = (p) => h(Svg, Object.assign({ width: 14, height: 14 }, p), h("path", { d: "m6 9 6 6 6-6" }));
    const IconChevronRight = (p) => h(Svg, Object.assign({ width: 16, height: 16 }, p), h("path", { d: "m9 6 6 6-6 6" }));
    const IconSearch = (p) => h(Svg, p, h("circle", { cx: 11, cy: 11, r: 7 }), h("path", { d: "m20 20-3.2-3.2" }));
    const IconMore = (p) => h(Svg, p, h("circle", { cx: 5, cy: 12, r: 1.6, fill: "currentColor" }), h("circle", { cx: 12, cy: 12, r: 1.6, fill: "currentColor" }), h("circle", { cx: 19, cy: 12, r: 1.6, fill: "currentColor" }));
    const IconRefresh = (p) => h(Svg, p, h("path", { d: "M20 11a8 8 0 1 0-2.3 5.7" }), h("path", { d: "M20 4v7h-7" }));
    const IconPlus = (p) => h(Svg, p, h("path", { d: "M12 5v14M5 12h14" }));
    const IconTrash = (p) => h(Svg, p, h("path", { d: "M4 7h16M10 11v6M14 11v6" }), h("path", { d: "M6 7l1 13h10l1-13" }), h("path", { d: "M9 7V4h6v3" }));
    const IconClose = (p) => h(Svg, p, h("path", { d: "m6 6 12 12M18 6 6 18" }));
    const IconCheck = (p) => h(Svg, p, h("path", { d: "m5 13 4 4 10-10" }));
    const IconCopy = (p) => h(Svg, p, h("rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }), h("path", { d: "M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" }));
    const IconImport = (p) => h(Svg, p, h("path", { d: "M12 3v11" }), h("path", { d: "m8 10 4 4 4-4" }), h("path", { d: "M4 19h16" }));
    const IconInfo = (p) => h(Svg, p, h("circle", { cx: 12, cy: 12, r: 9 }), h("path", { d: "M12 11v5" }), h("path", { d: "M12 8h.01" }));
    const IconSparkle = (p) => h(Svg, p, h("path", { d: "M12 3c1 4 2 5 6 6-4 1-5 2-6 6-1-4-2-5-6-6 4-1 5-2 6-6Z" }), h("path", { d: "M18 15c.5 2 1 2.5 3 3-2 .5-2.5 1-3 3-.5-2-1-2.5-3-3 2-.5 2.5-1 3-3Z" }));
    const IconLayers = (p) => h(Svg, p, h("rect", { x: 4, y: 4, width: 12, height: 12, rx: 2 }), h("path", { d: "M9 20h9a2 2 0 0 0 2-2V9" }));

    /* ---------------------------------------------------------------- */
    /* Markdown：纯解析（可单测）+ React 渲染                              */
    /* ---------------------------------------------------------------- */

    /** 允许的链接协议：其余（javascript:、data: 等）一律降级为纯文本。 */
    const SAFE_LINK = /^(?:https?:|mailto:|tel:|#|\/)/i;

    /**
     * 行内标记解析（纯函数，不依赖 React）：行内代码、**粗体**、*斜体*、~~删除线~~、[链接](url)。
     * @returns {Array<{ type: string, text: string, href?: string }>}
     */
    function parseInline(text) {
      const nodes = [];
      const source = String(text == null ? "" : text);
      const pattern = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(~~[^~]+?~~)|(\[[^\]\n]*?\]\([^)\s]*?\))|(\*[^*\s][^*\n]*?\*)/g;
      let last = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > last) nodes.push({ type: "text", text: source.slice(last, match.index) });
        const token = match[0];
        if (token.startsWith("`")) {
          nodes.push({ type: "code", text: token.slice(1, -1) });
        } else if (token.startsWith("**")) {
          nodes.push({ type: "strong", text: token.slice(2, -2) });
        } else if (token.startsWith("~~")) {
          nodes.push({ type: "del", text: token.slice(2, -2) });
        } else if (token.startsWith("[")) {
          const link = /\[([^\]]*)\]\(([^)]*)\)/.exec(token);
          const label = link ? link[1] : token;
          const href = link ? link[2].trim() : "";
          // 非白名单协议（如 javascript:）不生成可点链接，只当普通文本。
          if (SAFE_LINK.test(href)) nodes.push({ type: "link", text: label, href });
          else nodes.push({ type: "text", text: token });
        } else {
          nodes.push({ type: "em", text: token.slice(1, -1) });
        }
        last = match.index + token.length;
      }
      if (last < source.length) nodes.push({ type: "text", text: source.slice(last) });
      return nodes;
    }

    /**
     * 块级 Markdown 解析（纯函数，不依赖 React）：代码块、标题、分隔线、引用、有序/无序列表、段落。
     * @returns {Array<{ type: string, level?: number, text?: string, items?: string[], children?: any[] }>}
     */
    function parseMarkdown(text) {
      const lines = String(text == null ? "" : text).replace(/\r\n/g, "\n").split("\n");
      const blocks = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === "") { i += 1; continue; }

        if (/^```/.test(line.trim())) {
          const buffer = [];
          i += 1;
          while (i < lines.length && !/^```/.test(lines[i].trim())) {
            buffer.push(lines[i]);
            i += 1;
          }
          i += 1;
          blocks.push({ type: "code", text: buffer.join("\n") });
          continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          blocks.push({ type: "h", level: heading[1].length, text: heading[2] });
          i += 1;
          continue;
        }

        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push({ type: "hr" });
          i += 1;
          continue;
        }

        if (/^\s*>\s?/.test(line)) {
          const buffer = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            buffer.push(lines[i].replace(/^\s*>\s?/, ""));
            i += 1;
          }
          blocks.push({ type: "quote", children: parseMarkdown(buffer.join("\n")) });
          continue;
        }

        const isOrdered = /^\s*\d+[.)]\s+/.test(line);
        if (isOrdered || /^\s*[-*+]\s+/.test(line)) {
          const items = [];
          while (i < lines.length) {
            const item = isOrdered ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]) : /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
            if (!item) break;
            items.push(item[1]);
            i += 1;
          }
          blocks.push({ type: isOrdered ? "ol" : "ul", items });
          continue;
        }

        const buffer = [];
        while (
          i < lines.length
          && lines[i].trim() !== ""
          && !/^```/.test(lines[i].trim())
          && !/^\s*[-*+]\s+/.test(lines[i])
          && !/^\s*\d+[.)]\s+/.test(lines[i])
          && !/^#{1,6}\s/.test(lines[i])
          && !/^\s*>\s?/.test(lines[i])
          && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
        ) {
          buffer.push(lines[i]);
          i += 1;
        }
        if (buffer.length === 0) { i += 1; continue; }
        blocks.push({ type: "p", text: buffer.join("\n") });
      }
      return blocks;
    }

    /** 行内节点 → React 节点。 */
    function renderInline(nodes, keyPrefix) {
      return nodes.map((node, index) => {
        const key = keyPrefix + index;
        if (node.type === "code") return h("code", { key, className: "dsm-md-code" }, node.text);
        if (node.type === "strong") return h("strong", { key }, node.text);
        if (node.type === "em") return h("em", { key }, node.text);
        if (node.type === "del") return h("del", { key }, node.text);
        if (node.type === "link") return h("a", { key, href: node.href, target: "_blank", rel: "noreferrer noopener" }, node.text);
        return node.text;
      });
    }

    /** 块 → React 元素。 */
    function renderBlocks(blocks, keyPrefix) {
      const prefix = keyPrefix || "b";
      return blocks.map((block, index) => {
        const key = prefix + index;
        if (block.type === "code") return h("pre", { key, className: "dsm-md-pre" }, h("code", null, block.text));
        if (block.type === "h") return h("h" + block.level, { key, className: "dsm-md-h" }, renderInline(parseInline(block.text), key + "i"));
        if (block.type === "hr") return h("hr", { key, className: "dsm-md-hr" });
        if (block.type === "quote") return h("blockquote", { key, className: "dsm-md-quote" }, renderBlocks(block.children, key + "c"));
        if (block.type === "ul" || block.type === "ol") {
          return h(block.type, { key, className: "dsm-md-list" }, block.items.map((item, position) => h("li", { key: key + "l" + position }, renderInline(parseInline(item), key + "l" + position + "i"))));
        }
        return h("p", { key, className: "dsm-md-p" }, renderInline(parseInline(block.text), key + "i"));
      });
    }

    /** 对外：Markdown 文本 → React 节点。 */
    function renderMarkdown(text) {
      return renderBlocks(parseMarkdown(text), "b");
    }

    /* ---------------------------------------------------------------- */
    /* 数据访问                                                          */
    /* ---------------------------------------------------------------- */

    /** 请求超时上限：宿主卡住时不让界面永远停在「加载中」。 */
    const REQUEST_TIMEOUT_MS = 10000;

    async function apiGet(path, params) {
      const query = params ? "?" + new URLSearchParams(params).toString() : "";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(API + path + query, { headers: { accept: "application/json" }, signal: controller.signal });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) throw new Error(payload.error || "请求失败：" + response.status);
        return payload;
      } catch (error) {
        if (error && error.name === "AbortError") throw new Error("请求超时（10 秒），宿主无响应");
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    async function apiPost(path, body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(API + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) throw new Error(payload.error || "请求失败：" + response.status);
        return payload;
      } catch (error) {
        if (error && error.name === "AbortError") throw new Error("请求超时（10 秒），宿主无响应");
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    /* ---------------------------------------------------------------- */
    /* 小组件                                                            */
    /* ---------------------------------------------------------------- */

    function Switch(props) {
      const on = props.on;
      return h("button", {
        type: "button",
        className: "dsm-switch",
        role: "switch",
        "aria-checked": on ? "true" : "false",
        "aria-label": props.label || "开关",
        "data-on": on ? "true" : "false",
        disabled: props.disabled || false,
        onClick: (event) => { event.stopPropagation(); props.onChange(!on); },
      }, h("span", { className: "dsm-switchKnob" }));
    }

    function IconButton(props, children) {
      return h("button", {
        type: "button",
        className: props.className || "dsm-iconBtn",
        "aria-label": props.label,
        title: props.title || props.label,
        onClick: (event) => { event.stopPropagation(); props.onClick(event); },
      }, children);
    }

    function Dropdown(props) {
      const [open, setOpen] = useState(false);
      const ref = useRef(null);
      useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (ref.current && !ref.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setOpen(false);
          }
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);
      const menuClass = "dsm-menu" + (props.menuUp ? " dsm-menuUp" : "") + (props.menuRight ? " dsm-menuRight" : "");
      return h("div", { className: props.className || "dsm-select", ref: ref },
        h("button", {
          type: "button",
          className: props.buttonClassName || "dsm-selectBtn",
          onClick: () => setOpen((value) => !value),
          "aria-haspopup": "menu",
          "aria-expanded": open ? "true" : "false",
        }, props.trigger, props.hideCaret ? null : h(IconCaret, null)),
        open ? h("div", { className: menuClass, role: "menu" }, props.children(open ? () => setOpen(false) : () => {})) : null,
      );
    }

    function Modal(props) {
      const ref = useRef(null);
      const restoreRef = useRef(null);
      useEffect(() => {
        restoreRef.current = document.activeElement;
        if (ref.current) ref.current.focus();
        const onKey = (event) => {
          if (event.key !== "Escape") return;
          // 只关自己：别把宿主设置面板一起关掉。
          event.stopPropagation();
          props.onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("keydown", onKey);
          const restore = restoreRef.current;
          if (restore && typeof restore.focus === "function") restore.focus();
        };
      }, [props.onClose]);
      return h("div", {
        className: "dsm-overlay",
        onMouseDown: (event) => { if (event.target === event.currentTarget) props.onClose(); },
      }, h("div", {
        className: "dsm-modal" + (props.modalClassName ? " " + props.modalClassName : ""),
        role: "dialog",
        "aria-modal": "true",
        "aria-label": props.label || "对话框",
        tabIndex: -1,
        ref: ref,
      }, props.children));
    }

    /* ---------------------------------------------------------------- */
    /* 详情弹窗                                                          */
    /* ---------------------------------------------------------------- */

    /** 技能的作用范围：个人 / 项目名 / 内置。 */
    function scopeTextOf(skill) {
      const source = skill.source || "";
      if (source === "project-dsh" || source === "project-agents") {
        const parts = String(skill.rootPath || "").split(/[\\/]+/).filter(Boolean);
        // 根目录形如 <projectRoot>/.dsh/skills，倒退两级即项目根，取其末段做名字。
        return parts.length >= 3 ? parts[parts.length - 3] : "工作区";
      }
      if (source === "bundled" || source === "runtime") return "内置";
      return "个人";
    }

    function DetailModal(props) {
      const skill = props.skill;
      const [detail, setDetail] = useState(null);
      const [error, setError] = useState(null);
      const [copied, setCopied] = useState(null);
      useEffect(() => {
        let alive = true;
        setDetail(null);
        setError(null);
        setCopied(null);
        apiPost("/body", { name: skill.name, cwd: props.cwd })
          .then((payload) => { if (alive) setDetail(payload); })
          .catch((err) => { if (alive) setError(String(err && err.message ? err.message : err)); });
        return () => { alive = false; };
      }, [skill.name, props.cwd]);

      const copyPath = () => {
        const path = (detail && detail.skill && detail.skill.path) || skill.path || "";
        if (!path) return;
        // 剪贴板可能不可用（非安全上下文）或被拒绝：给出反馈，不要静默失败。
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(path)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
          return;
        }
        setCopied(false);
      };

      const scopeText = scopeTextOf(skill);
      const statusText = skill.invocation && skill.invocation.modelInvocable === false ? "已禁用" : "已启用";
      const descriptionText = (detail && detail.frontmatter && typeof detail.frontmatter.description === "string" && detail.frontmatter.description !== "")
        ? detail.frontmatter.description
        : skill.description || "";

      return h(Modal, { onClose: props.onClose, label: skill.name + " 详情" },
        h("div", { className: "dsm-modalHead" },
          h("span", { className: "dsm-modalTitle" }, skill.name),
          h("div", { style: { marginLeft: "auto" } },
            IconButton({ className: "dsm-iconBtnSm", label: "关闭", onClick: props.onClose }, h(IconClose, null))),
        ),
        h("div", { className: "dsm-modalBody" },
          h("div", { className: "dsm-label" }, "描述"),
          h("div", { className: "dsm-mdScroll" }, error
            ? h("div", { className: "dsm-error" }, error)
            : descriptionText
              ? renderMarkdown(descriptionText)
              : h("span", { className: "dsm-muted" }, "（该技能没有描述）")),
          h("div", { className: "dsm-twoCol" },
            h("div", null,
              h("div", { className: "dsm-label" }, "范围"),
              h("div", { className: "dsm-value" }, scopeText),
            ),
            h("div", null,
              h("div", { className: "dsm-label" }, "状态"),
              h("div", { className: "dsm-value" }, statusText),
            ),
          ),
          h("div", { className: "dsm-label" }, "文件路径"),
          h("div", { className: "dsm-pathRow" },
            h("code", { className: "dsm-path", title: skill.path || "" }, skill.path || "（内置技能，无本地文件）"),
            IconButton({ className: "dsm-iconBtnSm", label: copied === null ? "复制路径" : copied ? "已复制" : "复制失败", onClick: copyPath }, h(IconCopy, null)),
          ),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* 导入弹窗                                                          */
    /* ---------------------------------------------------------------- */

    function ImportModal(props) {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [selected, setSelected] = useState(() => new Set());
      const [mode, setMode] = useState("link");
      // 只有作用域本身就是工作区时才允许「导入到项目」——否则宿主会落到全局根，
      // 按钮却写着「导入到项目」，用户以为装到了项目里。
      const canProject = Boolean(props.cwd);
      const [target, setTarget] = useState(props.scopeKind === "project" && props.cwd ? "project" : "global");
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);

      const load = useCallback(() => {
        let alive = true;
        setError(null);
        apiGet("/external")
          .then((payload) => { if (!alive) return; setData(payload); setSelected(new Set()); })
          .catch((err) => { if (!alive) return; setError(String(err && err.message ? err.message : err)); });
        return () => { alive = false; };
      }, []);

      useEffect(() => { load(); }, [load]);
      useEffect(() => { if (!canProject) setTarget("global"); }, [canProject]);

      const sources = (data && data.sources) || [];
      // 选择键用「来源::名字」：不同外部目录可能存在同名技能，按名字去重会互相串选。
      const keyOf = (skill) => skill.source + "::" + skill.name;
      const allSkills = [];
      for (const source of sources) {
        for (const skill of source.skills || []) {
          // 顺序要紧：宿主返回的技能对象里可能带 source 字段，不能覆盖来源 id。
          allSkills.push(Object.assign({}, skill, { source: source.id, installed: Boolean(skill.installed) }));
        }
      }
      const importable = allSkills.filter((skill) => !skill.installed);

      const allChecked = importable.length > 0 && importable.every((skill) => selected.has(keyOf(skill)));
      const toggleAll = () => {
        setSelected((previous) => {
          const all = importable.every((skill) => previous.has(keyOf(skill)));
          if (all) return new Set();
          const next = new Set();
          for (const skill of importable) next.add(keyOf(skill));
          return next;
        });
      };

      const toggleSource = (source) => {
        const items = (source.skills || []).filter((skill) => !skill.installed);
        setSelected((previous) => {
          const next = new Set(previous);
          const allOn = items.length > 0 && items.every((skill) => next.has(keyOf(Object.assign({}, skill, { source: source.id }))));
          for (const skill of items) {
            const key = source.id + "::" + skill.name;
            if (allOn) next.delete(key);
            else next.add(key);
          }
          return next;
        });
      };

      const doImport = async () => {
        setBusy(true);
        setError(null);
        setResult(null);
        let done = 0;
        const failures = [];
        // 逐条导入：一条失败不能把后面的选中项一起废掉。
        for (const skill of importable) {
          if (!selected.has(keyOf(skill))) continue;
          try {
            await apiPost("/import", { source: skill.source, name: skill.name, mode, target, cwd: props.cwd });
            done += 1;
          } catch (err) {
            failures.push(skill.name + "：" + String(err && err.message ? err.message : err));
          }
        }
        setResult("已导入 " + done + " 个技能" + (failures.length > 0 ? "，失败 " + failures.length + " 个" : ""));
        if (failures.length > 0) setError(failures.join("；"));
        setBusy(false);
        load();
        props.onImported();
      };

      const targetLabel = target === "project" ? "导入到项目" : "导入到全局";

      return h(Modal, { onClose: props.onClose, modalClassName: "dsm-importModal", label: "导入外部 Agent 技能" },
        h("div", { className: "dsm-modalHead" },
          h("span", { className: "dsm-modalTitle" }, "导入外部 Agent 技能"),
          h("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" } },
            h(Dropdown, {
              buttonClassName: "dsm-selectBtn",
              trigger: h("span", null, target === "project" ? "项目" : "全局"),
              children: (close) => [
                h("button", { key: "global", type: "button", className: "dsm-menuItem", role: "menuitem", onClick: () => { setTarget("global"); close(); } },
                  h("span", null, "全局"),
                  target === "global" ? h(IconCheck, null) : null),
                canProject
                  ? h("button", { key: "project", type: "button", className: "dsm-menuItem", role: "menuitem", onClick: () => { setTarget("project"); close(); } },
                    h("span", null, "项目"),
                    target === "project" ? h(IconCheck, null) : null)
                  : null,
              ],
            }),
            IconButton({ className: "dsm-iconBtnSm", label: "重新扫描", onClick: load }, h(IconRefresh, null)),
            IconButton({ className: "dsm-iconBtnSm", label: "关闭", onClick: props.onClose }, h(IconClose, null)),
          ),
        ),
        h("div", { className: "dsm-importBody" },
          h("div", { className: "dsm-importCard" },
            h("div", { className: "dsm-selectAll" },
              h("input", { type: "checkbox", className: "dsm-check", checked: allChecked, "aria-label": "全选可导入技能", onChange: toggleAll }),
              h("span", null, "全选"),
              h("span", { className: "dsm-selCount" }, "已选 " + selected.size + "/" + importable.length),
            ),
            sources.map((source) => {
              const sourceItems = (source.skills || []).filter((skill) => !skill.installed);
              const sourceChecked = sourceItems.length > 0 && sourceItems.every((skill) => selected.has(source.id + "::" + skill.name));
              return h("div", {
                key: source.id,
                className: "dsm-sourceRow",
                role: "button",
                tabIndex: 0,
                onClick: () => toggleSource(source),
                onKeyDown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleSource(source); } },
              },
                h("input", {
                  type: "checkbox",
                  className: "dsm-check",
                  checked: sourceChecked,
                  "aria-label": "选择 " + source.label + " 的全部技能",
                  onClick: (event) => event.stopPropagation(),
                  onChange: () => toggleSource(source),
                }),
                h("div", { className: "dsm-sourceMain" },
                  h("div", { className: "dsm-sourceName", title: source.label }, source.label),
                  h("div", { className: "dsm-sourcePath", title: source.path }, source.path),
                ),
                h("div", { className: "dsm-sourceCount" }, source.count + " 个技能"),
                h(IconChevronRight, null),
              );
            }),
          ),
          error ? h("div", { className: "dsm-error" }, error) : null,
          result ? h("div", { className: "dsm-footNote" }, result) : null,
        ),
        h("div", { className: "dsm-importFoot" },
          h("div", { className: "dsm-footLeft" },
            h("span", null, "发现 " + importable.length + " 个可导入技能"),
            h(Dropdown, {
              buttonClassName: "dsm-selectBtn",
              menuUp: true,
              trigger: h("span", null, mode === "link" ? "软链" : "直接复制"),
              children: (close) => [
                h("button", { key: "link", type: "button", className: "dsm-menuItem", role: "menuitem", onClick: () => { setMode("link"); close(); } },
                  h("span", null, "软链"), mode === "link" ? h(IconCheck, null) : null),
                h("button", { key: "copy", type: "button", className: "dsm-menuItem", role: "menuitem", onClick: () => { setMode("copy"); close(); } },
                  h("span", null, "直接复制"), mode === "copy" ? h(IconCheck, null) : null),
              ],
            }),
            h(IconInfo, { title: mode === "link" ? "软链：在目标根创建指向原目录的链接（Windows 使用 junction，免管理员权限）" : "直接复制：把技能目录完整复制到目标根" }),
          ),
          h("div", { className: "dsm-footRight" },
            h("button", { type: "button", className: "dsm-primary", disabled: busy || selected.size === 0, onClick: doImport },
              h("span", null, targetLabel), h(IconCaret, null)),
          ),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* 新建弹窗                                                          */
    /* ---------------------------------------------------------------- */

    function CreateModal(props) {
      const [name, setName] = useState("");
      const [description, setDescription] = useState("");
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      // 同步锁：busy 是异步生效的，连点两次会发两次请求（第二次 409）。
      const submitting = useRef(false);

      const submit = async () => {
        if (submitting.current) return;
        submitting.current = true;
        setBusy(true);
        setError(null);
        try {
          await apiPost("/create", { name: name.trim(), description: description.trim(), cwd: props.cwd, target: props.scopeKind === "project" ? "project" : "global" });
          props.onCreated();
          props.onClose();
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          submitting.current = false;
          setBusy(false);
        }
      };

      return h(Modal, { onClose: props.onClose },
        h("div", { className: "dsm-modalHead" },
          h("span", { className: "dsm-modalTitle" }, "新建技能"),
          h("div", { style: { marginLeft: "auto" } },
            IconButton({ className: "dsm-iconBtnSm", label: "关闭", onClick: props.onClose }, h(IconClose, null))),
        ),
        h("div", { className: "dsm-modalBody" },
          h("div", { className: "dsm-field" },
            h("div", { className: "dsm-label" }, "名称（kebab-case，仅小写字母、数字与连字符）"),
            h("input", {
              className: "dsm-input",
              value: name,
              placeholder: "my-skill",
              maxLength: 64,
              onChange: (event) => setName(event.target.value),
            }),
          ),
          h("div", { className: "dsm-field" },
            h("div", { className: "dsm-label" }, "描述（" + description.length + "/500）"),
            h("textarea", {
              className: "dsm-textarea",
              value: description,
              placeholder: "这个技能解决什么问题",
              maxLength: 500,
              onChange: (event) => setDescription(event.target.value),
            }),
          ),
          error ? h("div", { className: "dsm-error" }, error) : null,
          h("div", { className: "dsm-footNote" }, "将创建到 " + (props.scopeKind === "project" ? "当前工作区的 .dsh/skills 目录" : "全局 ~/.dsh/skills 目录") + "，并生成一份最小可用的 SKILL.md。"),
          h("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "4px" } },
            h("button", { type: "button", className: "dsm-btnText", onClick: props.onClose }, "取消"),
            h("button", { type: "button", className: "dsm-primary", disabled: busy || name.trim() === "" || description.trim() === "", onClick: submit },
              h(IconPlus, null), h("span", null, "创建")),
          ),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    /* 主面板                                                            */
    /* ---------------------------------------------------------------- */

    const WRITABLE_ROOT_KINDS = new Set(["global", "project", "custom"]);

    function Panel() {
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);
      const [search, setSearch] = useState("");
      const [scope, setScope] = useState({ kind: "global", path: "", title: "" });
      const [detail, setDetail] = useState(null);
      const [showImport, setShowImport] = useState(false);
      const [showCreate, setShowCreate] = useState(false);
      const [notice, setNotice] = useState(null);
      const [confirmRemove, setConfirmRemove] = useState(null);
      // 请求序号：作用域快速切换时，过期响应不得覆盖新数据。
      const requestSeq = useRef(0);

      const cwd = scope.kind === "project" ? scope.path : "";

      const load = useCallback(() => {
        const seq = requestSeq.current + 1;
        requestSeq.current = seq;
        setLoading(true);
        apiGet("/state", cwd ? { cwd } : {})
          .then((payload) => {
            if (seq !== requestSeq.current) return;
            setState(payload);
            setError(null);
          })
          .catch((err) => {
            if (seq !== requestSeq.current) return;
            setError(String(err && err.message ? err.message : err));
          })
          .finally(() => {
            if (seq !== requestSeq.current) return;
            setLoading(false);
          });
      }, [cwd]);

      // 写操作完成后的刷新必须走「最新」的加载器，不能用点击那一刻闭包里的旧 load()：
      // 否则作用域切换后，旧闭包会把面板钉回旧作用域，用户按新作用域理解去删技能就可能误删。
      const loadRef = useRef(load);
      useEffect(() => { loadRef.current = load; }, [load]);

      useEffect(() => { load(); }, [load]);

      const skills = (state && state.skills) || [];
      const totals = (state && state.totals) || { skills: 0, installed: 0 };

      const roots = useMemo(() => (state && state.roots) || [], [state]);
      const rootTitle = useMemo(() => {
        const map = new Map();
        for (const root of roots) map.set(root.label, root.title);
        return map;
      }, [roots]);
      // 可写根由宿主给出（root.kind），客户端不再另写一份白名单——
      // 否则用户自定义目录里的技能会被误判成只读，开关与删除全消失。
      const writableSources = useMemo(() => {
        const set = new Set();
        for (const root of roots) {
          if (WRITABLE_ROOT_KINDS.has(root.kind)) set.add(root.label);
        }
        return set;
      }, [roots]);

      const filtered = useMemo(() => {
        const needle = search.trim().toLowerCase();
        if (needle === "") return skills;
        return skills.filter((skill) => {
          return [skill.name, skill.description, skill.path, skill.source].some((field) => String(field || "").toLowerCase().includes(needle));
        });
      }, [skills, search]);

      const installed = useMemo(
        () => filtered.filter((skill) => writableSources.has(skill.source) && skill.exists),
        [filtered, writableSources],
      );
      const builtin = useMemo(
        () => filtered.filter((skill) => !(writableSources.has(skill.source) && skill.exists)),
        [filtered, writableSources],
      );

      const builtinGroups = useMemo(() => {
        const groups = new Map();
        for (const skill of builtin) {
          const key = skill.source || "runtime";
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(skill);
        }
        return [...groups.entries()];
      }, [builtin]);

      const scopeLabel = scope.kind === "project" ? scope.title + " · 本机" : "用户 · 本机";

      const toggleSkill = async (skill, next) => {
        setNotice(null);
        try {
          await apiPost("/toggle", { name: skill.name, disabled: !next, cwd });
          loadRef.current();
        } catch (err) {
          setNotice(String(err && err.message ? err.message : err));
        }
      };

      const removeSkill = async (skill) => {
        setNotice(null);
        try {
          await apiPost("/remove", { name: skill.name, cwd });
          setConfirmRemove(null);
          loadRef.current();
        } catch (err) {
          setNotice(String(err && err.message ? err.message : err));
        }
      };

      const openDirectory = async (skill) => {
        setNotice(null);
        try {
          await apiPost("/reveal", { name: skill.name, cwd });
        } catch (err) {
          setNotice(String(err && err.message ? err.message : err));
        }
      };

      const renderRow = (skill) => {
        const writable = writableSources.has(skill.source) && skill.exists;
        const enabled = !skill.invocation || skill.invocation.modelInvocable !== false;
        return h("div", {
          key: skill.name,
          className: "dsm-row",
          role: "button",
          tabIndex: 0,
          onClick: () => setDetail(skill),
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setDetail(skill);
            }
          },
        },
          h("div", { className: "dsm-icon" }, writable ? h(IconSparkle, null) : h(IconLayers, null)),
          h("div", { className: "dsm-rowMain" },
            h("div", { className: "dsm-name", title: skill.name }, skill.name),
            h("div", { className: "dsm-desc", title: skill.description }, skill.description || "（无描述）"),
          ),
          writable
            ? h(Switch, { on: enabled, label: "启用模型调用 " + skill.name, onChange: (next) => toggleSkill(skill, next) })
            : h("span", { className: "dsm-badge" }, "只读"),
          writable
            ? IconButton({ className: "dsm-trash", label: "删除 " + skill.name, onClick: () => setConfirmRemove(skill) }, h(IconTrash, null))
            : skill.path
              ? IconButton({ className: "dsm-trash", label: "打开目录 " + skill.name, onClick: () => openDirectory(skill) }, h(IconFolder, null))
              : null,
        );
      };

      return h("div", { className: "dsm-root" },
        h("h1", { className: "dsm-title" }, "技能"),

        h("div", { className: "dsm-toolbar" },
          h(Dropdown, {
            className: "dsm-scope",
            buttonClassName: "dsm-scopeBtn",
            trigger: h("span", { style: { display: "inline-flex", alignItems: "center", gap: "8px" } },
              scope.kind === "project" ? h(IconFolder, null) : h(IconMonitor, null),
              h("span", null, scopeLabel),
            ),
            children: (close) => [
              h("button", {
                key: "global",
                type: "button",
                className: "dsm-menuItem",
                onClick: () => { setScope({ kind: "global", path: "", title: "" }); close(); },
              }, h(IconMonitor, null), h("span", null, "用户 · 本机"), scope.kind === "global" ? h(IconCheck, null) : null),
              h("div", { key: "label", className: "dsm-menuLabel" }, "工作区"),
              ((state && state.workspaces) || []).map((workspace) => h("button", {
                key: workspace.id,
                type: "button",
                className: "dsm-menuItem",
                onClick: () => { setScope({ kind: "project", path: workspace.path, title: workspace.title }); close(); },
              }, h(IconFolder, null), h("span", null, workspace.title + " · 本机"), scope.path === workspace.path ? h(IconCheck, null) : null)),
            ],
          }),
          h("div", { className: "dsm-divider" }),
          h("div", { className: "dsm-meta" }, "技能 ", h("b", null, String(totals.skills || 0))),
          h("div", { className: "dsm-searchWrap" },
            h(IconSearch, null),
            h("input", {
              className: "dsm-search",
              value: search,
              placeholder: "搜索技能...",
              onChange: (event) => setSearch(event.target.value),
            }),
          ),
        ),

        h("div", { className: "dsm-sectionHead" },
          h("div", { className: "dsm-sectionTitle" }, "已安装", h("span", { className: "dsm-sectionCount" }, String(installed.length))),
          h("div", { className: "dsm-actions" },
            h(Dropdown, {
              buttonClassName: "dsm-iconBtn",
              trigger: h(IconMore, null),
              hideCaret: true,
              menuRight: false,
              children: (close) => [
                h("button", { key: "import", type: "button", className: "dsm-menuItem", role: "menuitem", onClick: () => { close(); setShowImport(true); } },
                  h(IconImport, null), h("span", null, "导入")),
              ],
            }),
            IconButton({ className: "dsm-iconBtn", label: "刷新", onClick: load }, h(IconRefresh, null)),
            h("button", { type: "button", className: "dsm-primary", onClick: () => setShowCreate(true) },
              h(IconPlus, null), h("span", null, "新建")),
          ),
        ),

        notice ? h("div", { className: "dsm-error" }, notice) : null,
        // 刷新失败也要说出来：只在「还没有任何数据」时才显示错误，等于把刷新失败静默吞掉。
        error && state ? h("div", { className: "dsm-error" }, "刷新失败：" + error) : null,
        state && state.registryError ? h("div", { className: "dsm-footNote" }, "技能注册表暂不可用，当前仅显示本地扫描结果。") : null,

        loading && !state
          ? h("div", { className: "dsm-state" }, "加载中…")
          : error && !state
            ? h("div", { className: "dsm-state" },
              h("div", null, "加载失败：" + error),
              h("div", { style: { marginTop: "10px" } },
                h("button", { type: "button", className: "dsm-primary", onClick: load }, h("span", null, "重试"))),
            )
            : installed.length === 0 && builtin.length === 0
              ? h("div", { className: "dsm-state" }, "没有找到任何技能。")
              : null,

        installed.length > 0
          ? h("div", { className: "dsm-list" }, installed.map(renderRow))
          : null,

        builtinGroups.length > 0
          ? h("div", null,
            h("div", { className: "dsm-sectionHead" },
              h("div", { className: "dsm-sectionTitle" }, "内置", h("span", { className: "dsm-sectionCount" }, String(builtin.length))),
            ),
            builtinGroups.map(([source, group]) => h("div", { key: source },
              h("div", { className: "dsm-groupTitle" }, (rootTitle.get(source) || source) + " · " + group.length),
              h("div", { className: "dsm-list" }, group.map(renderRow)),
            )),
          )
          : null,

        detail ? h(DetailModal, { skill: detail, cwd, onClose: () => setDetail(null) }) : null,
        showImport ? h(ImportModal, { cwd, scopeKind: scope.kind, onClose: () => setShowImport(false), onImported: () => loadRef.current() }) : null,
        showCreate ? h(CreateModal, { cwd, scopeKind: scope.kind, onClose: () => setShowCreate(false), onCreated: () => loadRef.current() }) : null,
        confirmRemove
          ? h(Modal, { onClose: () => setConfirmRemove(null), label: "删除技能" },
            h("div", { className: "dsm-modalHead" },
              h("span", { className: "dsm-modalTitle" }, "删除技能"),
              h("div", { style: { marginLeft: "auto" } },
                IconButton({ className: "dsm-iconBtnSm", label: "关闭", onClick: () => setConfirmRemove(null) }, h(IconClose, null))),
            ),
            h("div", { className: "dsm-modalBody" },
              h("div", null, "确定删除技能「", h("b", null, confirmRemove.name), "」？"),
              h("div", { className: "dsm-pathRow", style: { marginTop: "8px" } },
                h("code", { className: "dsm-path", title: confirmRemove.path || "" }, confirmRemove.path || ""),
              ),
              h("div", { className: "dsm-footNote" }, "技能目录下的全部文件都会被移除，此操作不可撤销。"),
              h("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "4px" } },
                h("button", { type: "button", className: "dsm-btnText", onClick: () => setConfirmRemove(null) }, "取消"),
                h("button", { type: "button", className: "dsm-primary", onClick: () => removeSkill(confirmRemove) },
                  h(IconTrash, null), h("span", null, "删除")),
              ),
            ),
          )
          : null,
      );
    }

    /* ---------------------------------------------------------------- */
    /* 装配                                                              */
    /* ---------------------------------------------------------------- */

    function apply(ctx) {
      ensureStyles();
      if (ctx === null || typeof ctx !== "object" || !ctx.slots) {
        console.warn("[dsh-skills-manager] 宿主未提供 slots，设置分区未注册。");
        return;
      }
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "dsh-skills-manager",
            order: 11,
            label: () => "技能",
          },
          Panel,
        ),
      );
    }

    const inject = ["slots"];

    exports.apply = apply;
    exports.inject = inject;
    // 纯函数直测面：Markdown 解析与作用域判定不依赖 React/DOM，可在 node 里直接断言。
    exports.__pure = Object.freeze({
      parseInline,
      parseMarkdown,
      scopeTextOf,
    });
    return module.exports;
  },
});
