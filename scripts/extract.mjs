#!/usr/bin/env node
/**
 * worklog 素材提取器
 *
 * 从三路信号还原某一天的本地工作痕迹：
 *   1. Claude Code 会话 transcript（用户输入 / 子agent派发 / git动作 / 文档写入）
 *   2. Git 仓库提交（按 author date，非 committer date）
 *   3. 文件系统文档产出（仅非 git 目录的残差）
 *
 * 三路互斥：每个文件只由最合适的那一路负责。
 *
 * 用法：
 *   node extract.mjs --date 2026-10-12          输出 Markdown 素材
 *   node extract.mjs --date 26.10.12 --json     输出结构化 JSON
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const SCRIPT_DIR = import.meta.dirname;
const SKILL_ROOT = path.join(SCRIPT_DIR, '..');

// ────────────────────────────────────────────────────────────
// 参数
// ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { date: null, weekOf: null, json: false, config: null, init: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--init') out.init = true;
    else if (a === '--date') out.date = argv[++i];
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--week-of') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out.weekOf = next; i++; }
      else out.weekOf = 'today';
    }
  }
  return out;
}

/** 本地今天的 YYYY-MM-DD（不用 toISOString——那是 UTC 日） */
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 用法错误（参数不合法）——与运行时错误分开，退出码不同 */
class UsageError extends Error {}

/**
 * 接受 2026-10-12 与 26.10.12 两种写法，统一为 2026-10-12。
 *
 * 必须做回环校验：`new Date(2026, 12, 99)` 不报错，会静默滚成别的日期。
 * 少这一步的话，用户把 10-12 打成 13-99 不会得到任何提示，
 * 只会拿到另一天的素材——**错误静默发生**，比直接报错危险得多。
 */
function normalizeDate(s) {
  const raw = typeof s === 'string' ? s.trim() : '';
  if (!raw) throw new UsageError('未提供日期');

  let y, mo, d;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (m) {
    [, y, mo, d] = m;
  } else {
    m = /^(\d{2})\.(\d{1,2})\.(\d{1,2})$/.exec(raw);
    if (!m) throw new UsageError(`无法解析日期「${raw}」（支持 2026-10-12 或 26.10.12）`);
    y = `20${m[1]}`;
    mo = m[2];
    d = m[3];
  }

  const yn = Number(y);
  const mn = Number(mo);
  const dn = Number(d);
  const dt = new Date(yn, mn - 1, dn);
  if (dt.getFullYear() !== yn || dt.getMonth() !== mn - 1 || dt.getDate() !== dn) {
    throw new UsageError(`日期不存在：「${raw}」`);
  }
  return `${yn}-${String(mn).padStart(2, '0')}-${String(dn).padStart(2, '0')}`;
}

// ────────────────────────────────────────────────────────────
// 时间：全部走本地时区，绝不硬编码 +08:00
// ────────────────────────────────────────────────────────────

function dayRange(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  const startMs = start.getTime();
  const endMs = end.getTime();
  // 本地日跨两个 UTC 日，用作逐行快速排除的前缀集合
  const utcPrefixes = new Set([
    new Date(startMs).toISOString().slice(0, 10),
    new Date(endMs - 1).toISOString().slice(0, 10),
  ]);
  return { start, end, startMs, endMs, utcPrefixes };
}

/** 本地时刻，全角冒号，对齐用户既有 txt 与日报格式 */
function hhmm(ms) {
  const d = new Date(ms);
  return `${d.getHours()}：${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 26.10.12 形式的短日期 */
function shortDate(dt) {
  return `${String(dt.getFullYear()).slice(2)}.${dt.getMonth() + 1}.${dt.getDate()}`;
}

/**
 * 周归属：ISO 周（周一 00:00 至周日 24:00）。
 * 目录名与周报标题都用「该周周一 - 该周周日」，形如 26.10.12-26.10.18，
 * 使目录名恰好等于内容日期范围，加班日天然落在区间内，无需任何例外说明。
 */
function weekOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  const daysSinceMonday = (base.getDay() + 6) % 7; // getDay(): 0=周日
  const monday = new Date(y, m - 1, d - daysSinceMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return {
    weekDir: `${shortDate(monday)}-${shortDate(sunday)}`,
    dayFile: `${shortDate(base)}.md`,
    monday: `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`,
    sunday: `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`,
  };
}

// ────────────────────────────────────────────────────────────
// 用户真实输入的判定（spec §6.3 / §6.4）
// ────────────────────────────────────────────────────────────

// 两个打断标记都必须覆盖，只写一个会漏 35 条/全量样本
const INTERRUPT_MARKERS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);

const BARE_COMMAND = /^\/([A-Za-z:_-]+)$/;
const COMMAND_NAME_TAG = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS_TAG = /<command-args>([\s\S]*?)<\/command-args>/;

/** 技能展开、目录说明等非用户输入的固定前缀 */
const NOISE_PREFIXES = [
  '<task-notification>',
  '<command-message>',
  '<local-command-stdout>',
  'Base directory for this skill:',
  'Caveat:',
];

/**
 * 返回用户真实输入文本；不是真实输入则返回 null。
 *
 * 判据顺序不可调换：
 *   1. isMeta          —— 系统注入
 *   2. 噪声前缀         —— 后台任务通知 / 技能展开
 *   3. tool_result      —— 工具结果回流，不是人说的话
 *   4. 打断标记         —— 必须「整条相等」，子串匹配会误杀提及该词的真提问
 *   5. 裸命令 / 命令回显 —— 排除；但带 command-args 的技能调用是真提问
 */
function extractUserPrompt(rec) {
  if (rec.isMeta === true) return null;

  const content = rec.message?.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // 含任一 tool_result 块 → 这是工具结果回流，不是用户发言
    if (content.some((b) => b && typeof b === 'object' && b.type === 'tool_result')) return null;
    text = content
      .filter((b) => b && typeof b === 'object' && b.type === 'text')
      .map((b) => b.text || '')
      .join('\n');
  } else {
    return null;
  }

  text = text.trim();
  if (!text) return null;
  if (NOISE_PREFIXES.some((p) => text.startsWith(p))) return null;
  if (INTERRUPT_MARKERS.has(text)) return null;

  // 带参数的技能调用是真提问，取 <command-args> 内容
  const argsMatch = COMMAND_ARGS_TAG.exec(text);
  if (argsMatch) {
    const args = argsMatch[1].trim();
    return args || null;
  }

  if (BARE_COMMAND.test(text)) return null;
  if (COMMAND_NAME_TAG.test(text)) return null;

  return text;
}

// ────────────────────────────────────────────────────────────
// transcript 扫描
// ────────────────────────────────────────────────────────────

const DISPATCH_TOOLS = new Set(['Agent', 'Task']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const GIT_WRITE_RE = /\bgit\s+(commit|push|merge|checkout|rebase)\b/;
// 子 agent / workflow 的独立 transcript，不递归解析（spec §6.6）
const SUB_TRANSCRIPT_RE = /[\\/](subagents|agents|workflows)[\\/]/;

const CAP = {
  promptsPerSession: 200,
  dispatchesPerSession: 100,
  writesPerSession: 100,
  gitActionsPerSession: 60,
};

/**
 * 工具产物判定。transcript 的 file_path 里正反斜杠混用，所有匹配都按统一分隔符做。
 *   · 路径中任一段以 `.` 开头（`.feedback/`、`.claude/`、`.recon/`）
 *   · 文件名本身以 `.` 开头（`.tmp-msg-A.txt`）
 *   · 位于系统临时目录
 */
const DOT_DIR_RE = /[\\/]\.[^\\/]+[\\/]/;
const DOT_FILE_RE = /[\\/]\.[^\\/]+$/;
const TEMP_RE = /[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i;
function isNoisePath(p) {
  return DOT_DIR_RE.test(p) || DOT_FILE_RE.test(p) || TEMP_RE.test(p);
}

/**
 * 路径是否落在「当天有本人提交」的仓库内。是则由 git 侧负责，transcript 与文件扫描都不再重复报告。
 *
 * 判据是「该仓库当天有没有提交」而非「是不是仓库」——因为仓库里可能有未提交的当日产出
 * （实测某仓库内一份设计稿当日改动 22 次，但该仓库当天零提交），
 * 简单按仓库边界排除会连它一起丢掉。
 */
function inActiveRepo(p, activeRepos) {
  // 统一分隔符——transcript 的 file_path 正反斜杠混用（实测同一批记录里两种都有）
  const low = p.replace(/[\\/]+/g, path.sep).toLowerCase();
  for (const r of activeRepos) if (low.startsWith(r + path.sep)) return true;
  return false;
}

/**
 * 什么算「文档」：只有人类可读的交付物才算。
 * 代码/脚本/样式/图片资产（.js/.mjs/.ts/.json/.svg/.vue…）不算——那些由 git 侧负责。
 * 不过滤时实测单日 186 条，绝大多数是探针脚本与 slide SVG，会把素材淹掉。
 * 两路信号（transcript 写入 / 文件扫描）共用这一个口径。
 */
const DOC_EXT_RE = /\.(md|txt|docx|pptx|xlsx|pdf)$/i;
function isDocPath(p) {
  return DOC_EXT_RE.test(p);
}

function truncateNote(n, cap, what) {
  return n > cap ? `（本会话另有 ${n - cap} 条${what}未列出）` : '';
}

async function scanTranscripts(cfg, range, activeRepos, stats) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const excluded = new Set(cfg.excludeProjectDirs || []);
  const files = [];

  for (const projName of fs.readdirSync(projectsDir)) {
    if (excluded.has(projName)) continue;
    const projDir = path.join(projectsDir, projName);
    if (!fs.statSync(projDir).isDirectory()) continue;

    let entries;
    try {
      entries = fs.readdirSync(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const p = path.join(projDir, e.name);
      // 只读「当天及之后被写过」的文件——mtime 早于当天的文件不可能含当天记录。
      // 不做上界判断：跨天会话的 mtime 落在后一天，仍需纳入。
      try {
        if (fs.statSync(p).mtimeMs < range.startMs) continue;
      } catch {
        continue;
      }
      files.push(p);
    }
  }
  stats.filesScanned = files.length;

  const sessions = new Map();

  for (const file of files) {
    if (SUB_TRANSCRIPT_RE.test(file)) continue;
    let stream;
    try {
      stream = fs.createReadStream(file, { encoding: 'utf8' });
    } catch {
      stats.filesSkipped++;
      continue;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let session = null;
    try {
      for await (const line of rl) {
        // 快速排除：本地日对应的两个 UTC 日前缀都不在行内则跳过，避免无谓 JSON.parse
        if (![...range.utcPrefixes].some((d) => line.includes(d))) continue;

        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          stats.linesUnparsed++;
          continue;
        }

        const ts = Date.parse(rec.timestamp || '');
        if (!Number.isFinite(ts) || ts < range.startMs || ts >= range.endMs) continue;

        const type = rec.type;
        if (type !== 'user' && type !== 'assistant') continue;

        if (!session) {
          session = {
            sessionId: rec.sessionId || path.basename(file, '.jsonl'),
            cwd: null,
            firstMs: ts,
            lastMs: ts,
            prompts: [],
            dispatches: [],
            gitActions: [],
            writes: [],
          };
        }
        if (ts < session.firstMs) session.firstMs = ts;
        if (ts > session.lastMs) session.lastMs = ts;
        // 真实路径以 transcript 的 cwd 为准（first-seen-wins），绝不反解目录名
        if (!session.cwd && rec.cwd) session.cwd = rec.cwd;

        const blocks = rec.message?.content;
        if (!Array.isArray(blocks)) {
          if (type === 'user') {
            const text = extractUserPrompt(rec);
            if (text) session.prompts.push({ ms: ts, text });
          }
          continue;
        }

        if (type === 'user') {
          const text = extractUserPrompt(rec);
          if (text) session.prompts.push({ ms: ts, text });
          continue;
        }

        // assistant：抽 tool_use 块
        for (const b of blocks) {
          if (!b || typeof b !== 'object' || b.type !== 'tool_use') continue;
          const name = b.name;
          const input = b.input || {};
          if (DISPATCH_TOOLS.has(name)) {
            session.dispatches.push({
              ms: ts,
              tool: name,
              description: String(input.description || input.subagent_type || '').slice(0, 120),
            });
          } else if (name === 'Bash') {
            const cmd = String(input.command || '');
            const m = GIT_WRITE_RE.exec(cmd);
            if (m) session.gitActions.push({ ms: ts, sub: m[1], command: cmd.slice(0, 160) });
          } else if (WRITE_TOOLS.has(name)) {
            const fp = input.file_path || input.notebook_path;
            // 滤掉工具自动产物（.feedback/、Temp/）与非文档（脚本/样式/图片）；
            // 落在「当天有提交的仓库」内的由 git 侧负责，此处不重复
            const fpStr = fp ? String(fp) : '';
            if (fpStr && isDocPath(fpStr) && !isNoisePath(fpStr) && !inActiveRepo(fpStr, activeRepos)) {
              session.writes.push({ ms: ts, path: fpStr, tool: name });
            }
          }
        }
      }
    } catch {
      stats.filesSkipped++;
    } finally {
      rl.close();
      stream.destroy();
    }

    if (!session) continue;
    stats.filesParsed++;
    // 只保留有真实用户输入的会话——没有用户输入的会话是纯自动跑的子 agent/空会话
    if (session.prompts.length === 0 && session.dispatches.length === 0) continue;
    sessions.set(session.sessionId, session);
  }

  const list = [...sessions.values()].sort((a, b) => a.firstMs - b.firstMs);
  for (const s of list) {
    s.prompts.sort((a, b) => a.ms - b.ms);
    s.dispatches.sort((a, b) => a.ms - b.ms);
    s.gitActions.sort((a, b) => a.ms - b.ms);
    // 同一文件常被 Edit 数十次（实测单文件 40+ 次），按路径聚合为一条：首次时刻 + 改动次数
    const byPath = new Map();
    for (const w of s.writes) {
      const k = w.path.toLowerCase();
      const cur = byPath.get(k);
      if (!cur) byPath.set(k, { path: w.path, firstMs: w.ms, lastMs: w.ms, count: 1 });
      else {
        cur.count++;
        if (w.ms < cur.firstMs) cur.firstMs = w.ms;
        if (w.ms > cur.lastMs) cur.lastMs = w.ms;
      }
    }
    s.writes = [...byPath.values()].sort((a, b) => a.firstMs - b.firstMs);
  }
  stats.promptsFound = list.reduce((n, s) => n + s.prompts.length, 0);
  return list;
}

// ────────────────────────────────────────────────────────────
// Git 扫描
// ────────────────────────────────────────────────────────────

/** 递归发现 workRoots 下的 git 仓库 */
function discoverRepos(cfg, stats) {
  const roots = cfg.workRoots || [];
  const maxDepth = cfg.scanMaxDepth ?? 3;
  const excluded = new Set((cfg.excludeRepos || []).map((p) => path.resolve(p).toLowerCase()));
  const skipDirs = new Set(['node_modules', '__pycache__', 'site-packages', 'dist', 'out', 'build']);
  const repos = [];

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isDirectory() && e.name === '.git')) {
      const abs = path.resolve(dir);
      if (!excluded.has(abs.toLowerCase())) repos.push(abs);
      return; // 不进入仓库内部继续找嵌套仓库
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || skipDirs.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }

  for (const root of roots) walk(root, 1);
  stats.reposScanned = repos.length;
  return repos;
}

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    });
  } catch {
    return null;
  }
}

/** 作者白名单：email 为主、名字兜底（spec §5.3.2） */
function makeAuthorMatcher(cfg) {
  const ids = cfg.authorIdentities || {};
  const emails = new Set((ids.emails || []).map((e) => e.toLowerCase()));
  const names = new Set(ids.names || []);
  const fallbackEmail = (ids.nameFallbackEmail || '').toLowerCase();
  return (name, email) => {
    const e = (email || '').toLowerCase();
    if (emails.has(e)) return true;
    if (fallbackEmail && e === fallbackEmail && names.has(name)) return true;
    return false;
  };
}

function scanGit(cfg, range, repos, stats) {
  const match = makeAuthorMatcher(cfg);
  const subjects = [];
  // 粗筛窗口放宽 3 天：rebase 会把 committer date 前移，精确过滤在下面按 author date 做
  const since = new Date(range.startMs - 3 * 86400000).toISOString();
  const until = new Date(range.endMs + 86400000).toISOString();
  const sep = '\x1f';

  for (const repo of repos) {
    const out = sh('git', [
      '-C', repo, 'log',
      `--since=${since}`, `--until=${until}`,
      `--pretty=format:%h${sep}%aI${sep}%an${sep}%ae${sep}%s`,
    ]);
    if (!out) continue;
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [hash, aIso, an, ae, subject] = line.split(sep);
      if (!hash || !aIso) continue;
      const authorMs = Date.parse(aIso);
      // 必须按 author date 过滤——--since/--until 用的是 committer date
      if (!Number.isFinite(authorMs) || authorMs < range.startMs || authorMs >= range.endMs) continue;
      if (!match(an, ae)) continue;
      subjects.push({ repo, hash, ms: authorMs, name: an, subject: subject || '' });
    }
  }
  subjects.sort((a, b) => a.ms - b.ms);
  stats.commitsFound = subjects.length;
  return subjects;
}

// ────────────────────────────────────────────────────────────
// 文档扫描（仅非 git 目录的残差）
// ────────────────────────────────────────────────────────────

function scanDocs(cfg, range, activeRepos, sessions, stats) {
  const roots = cfg.workRoots || [];
  const maxDepth = cfg.scanMaxDepth ?? 3;
  const skipDirs = new Set(['node_modules', '__pycache__', 'site-packages']);

  // 已在 transcript / git 两路覆盖的路径，文件扫描不再重复捞
  const claimed = new Set();
  for (const s of sessions) for (const w of s.writes) claimed.add(path.resolve(w.path).toLowerCase());
  const repoPrefixes = activeRepos.map((r) => r.toLowerCase() + path.sep);

  const found = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // 排除所有点目录：一次覆盖 .git / .recon / .verify / .cache
        if (e.name.startsWith('.') || skipDirs.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile() && isDocPath(e.name)) {
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.mtimeMs < range.startMs || st.mtimeMs >= range.endMs) continue;
        const abs = path.resolve(full);
        const low = abs.toLowerCase();
        if (repoPrefixes.some((p) => low.startsWith(p))) continue; // 交给 git 侧
        if (claimed.has(low)) continue; // 交给 transcript 侧
        found.push({ path: abs, ms: st.mtimeMs });
      }
    }
  }
  for (const root of roots) walk(root, 1);

  found.sort((a, b) => a.ms - b.ms);
  stats.docsFound = found.length;
  return found;
}

// ────────────────────────────────────────────────────────────
// 渲染
// ────────────────────────────────────────────────────────────

function renderMarkdown(dateStr, range, sessions, commits, docs, stats) {
  const L = [];
  L.push(`# worklog 素材 ${dateStr}`);
  L.push('');
  L.push(`日期：${dateStr}（本地自然日，含周末，各条按实际时刻归属）`);
  L.push('');

  L.push('## 一、会话');
  L.push('');
  if (sessions.length === 0) {
    L.push('（无）');
    L.push('');
  }
  for (const s of sessions) {
    L.push(`### ${s.cwd || '(cwd 未知)'}  ${hhmm(s.firstMs)} — ${hhmm(s.lastMs)}`);
    L.push('');
    const p = s.prompts.slice(0, CAP.promptsPerSession);
    if (p.length) {
      L.push('用户输入：');
      for (const x of p) L.push(`  ${hhmm(x.ms)}  ${x.text.replace(/\s+/g, ' ').slice(0, 300)}`);
      const note = truncateNote(s.prompts.length, CAP.promptsPerSession, '输入');
      if (note) L.push(`  ${note}`);
      L.push('');
    }
    const d = s.dispatches.slice(0, CAP.dispatchesPerSession);
    if (d.length) {
      L.push('子 agent 派发：');
      for (const x of d) L.push(`  ${hhmm(x.ms)}  [${x.tool}] ${x.description || '(无描述)'}`);
      L.push('');
    }
    const g = s.gitActions.slice(0, CAP.gitActionsPerSession);
    if (g.length) {
      L.push('Git 动作（transcript 侧，辅助）：');
      for (const x of g) L.push(`  ${hhmm(x.ms)}  git ${x.sub}  ${x.command.replace(/\s+/g, ' ').slice(0, 120)}`);
      const note = truncateNote(s.gitActions.length, CAP.gitActionsPerSession, 'Git 动作');
      if (note) L.push(`  ${note}`);
      L.push('');
    }
    const w = s.writes.slice(0, CAP.writesPerSession);
    if (w.length) {
      L.push('文档写入（transcript 侧）：');
      for (const x of w) {
        const cnt = x.count > 1 ? `  （改动 ${x.count} 次，末次 ${hhmm(x.lastMs)}）` : '';
        L.push(`  ${hhmm(x.firstMs)}  ${x.path}${cnt}`);
      }
      const note = truncateNote(s.writes.length, CAP.writesPerSession, '文档');
      if (note) L.push(`  ${note}`);
      L.push('');
    }
  }

  L.push('## 二、Git 提交（权威口径）');
  L.push('');
  if (commits.length === 0) {
    L.push('（无）');
  } else {
    let cur = null;
    for (const c of commits) {
      if (c.repo !== cur) {
        cur = c.repo;
        L.push(`### ${c.repo}`);
        L.push('');
      }
      L.push(`  ${hhmm(c.ms)}  ${c.hash}  ${c.subject}`);
    }
  }
  L.push('');

  L.push('## 三、文档产出（非 git 目录，文件扫描）');
  L.push('');
  if (docs.length === 0) {
    L.push('（无）');
  } else {
    for (const d of docs) L.push(`  ${hhmm(d.ms)}  ${d.path}`);
  }
  L.push('');

  L.push('## 四、统计');
  L.push('');
  L.push(`文件扫描 ${stats.filesScanned} / 解析 ${stats.filesParsed} / 跳过 ${stats.filesSkipped} / 仓库 ${stats.reposScanned}`);
  L.push(`用户输入 ${stats.promptsFound} / 提交 ${stats.commitsFound} / 文档 ${stats.docsFound}`);
  L.push('');

  return L.join('\n');
}

// ────────────────────────────────────────────────────────────
// 配置校验
// ────────────────────────────────────────────────────────────

/**
 * 校验并补全配置。宁可启动就报清楚，也不要带着坏配置静默跑出错误结果。
 * 返回补好默认值的配置对象；不合法则抛错，错误信息直接告诉用户怎么改。
 */
function validateConfig(raw, cfgPath) {
  const errs = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`配置文件不是 JSON 对象：${cfgPath}`);
  }

  const strArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim());

  if (typeof raw.dataRoot !== 'string' || !raw.dataRoot.trim()) {
    errs.push('dataRoot: 必填，字符串（周报数据根目录的绝对路径）');
  }
  if (!strArr(raw.workRoots) || raw.workRoots.length === 0) {
    errs.push('workRoots: 必填，非空字符串数组（工作根目录，脚本在此递归找仓库与文档）');
  }

  const ids = raw.authorIdentities;
  if (!ids || typeof ids !== 'object' || Array.isArray(ids)) {
    errs.push('authorIdentities: 必填，对象，形如 {"emails":["me@corp.com"],"names":["myname"],"nameFallbackEmail":"dev@local"}');
  } else {
    const hasEmails = strArr(ids.emails) && ids.emails.length > 0;
    const hasNames = strArr(ids.names) && ids.names.length > 0;
    if (!hasEmails && !hasNames) {
      errs.push('authorIdentities.emails 与 .names 至少要有一个非空字符串数组（否则所有提交都会被过滤掉）');
    }
    if (ids.emails !== undefined && !strArr(ids.emails)) errs.push('authorIdentities.emails: 必须是字符串数组');
    if (ids.names !== undefined && !strArr(ids.names)) errs.push('authorIdentities.names: 必须是字符串数组');
    if (ids.nameFallbackEmail !== undefined && typeof ids.nameFallbackEmail !== 'string') {
      errs.push('authorIdentities.nameFallbackEmail: 必须是字符串');
    }
  }

  if (raw.scanMaxDepth !== undefined && (!Number.isInteger(raw.scanMaxDepth) || raw.scanMaxDepth < 1)) {
    errs.push('scanMaxDepth: 必须是 ≥1 的整数（可省略，默认 8）');
  }
  if (raw.excludeRepos !== undefined && !strArr(raw.excludeRepos)) errs.push('excludeRepos: 必须是字符串数组');
  if (raw.excludeProjectDirs !== undefined && !strArr(raw.excludeProjectDirs)) {
    errs.push('excludeProjectDirs: 必须是字符串数组');
  }
  if (raw.maxKeyframesPerDay !== undefined && (!Number.isInteger(raw.maxKeyframesPerDay) || raw.maxKeyframesPerDay < 1)) {
    errs.push('maxKeyframesPerDay: 必须是 ≥1 的整数（可省略，默认 15）');
  }

  if (errs.length) {
    throw new Error(`配置有误：${cfgPath}\n  · ${errs.join('\n  · ')}\n可运行 \`--init\` 查看建议值。`);
  }

  const cfg = {
    dataRoot: raw.dataRoot,
    workRoots: raw.workRoots,
    scanMaxDepth: raw.scanMaxDepth ?? 8,
    excludeRepos: raw.excludeRepos ?? [],
    authorIdentities: {
      emails: raw.authorIdentities.emails ?? [],
      names: raw.authorIdentities.names ?? [],
      nameFallbackEmail: raw.authorIdentities.nameFallbackEmail ?? '',
    },
    excludeProjectDirs: raw.excludeProjectDirs ?? [],
    maxKeyframesPerDay: raw.maxKeyframesPerDay ?? 15,
  };

  // 自指防护：dataRoot 若也在扫描范围内，worklog 自己的提交会被当成工作痕迹回灌
  const dr = path.resolve(cfg.dataRoot).toLowerCase();
  const excluded = cfg.excludeRepos.map((p) => path.resolve(p).toLowerCase());
  if (!excluded.includes(dr)) {
    cfg.__warnings = [
      `excludeRepos 未包含 dataRoot（${cfg.dataRoot}）。worklog 自己的自动提交可能被当成工作痕迹回灌，建议补上。`,
    ];
  }
  return cfg;
}

// ────────────────────────────────────────────────────────────
// 首次配置探测
// ────────────────────────────────────────────────────────────

/**
 * 探测建议配置。**不写任何文件**——产出只是建议，由模型与用户确认后落盘。
 *
 * 两条探测路径都不是猜的：
 *   · 工作根目录 —— 遍历 transcript 里每条记录顶层带的 cwd，按出现频次归纳。
 *     用户在哪干活，会话的 cwd 就指向哪，比让人手填靠谱。
 *   · 作者身份   —— 遍历发现的仓库，统计每个署名的提交数。
 *     这是配置里唯一「不查代码就填不出」的项：同一个人在不同仓库的署名可能不同
 *     （实测同一个人可能同时存在拼音与中文两个署名），光靠用户回忆必定漏。
 */
async function proposeConfig() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const cwdCount = new Map();

  if (fs.existsSync(projectsDir)) {
    for (const projName of fs.readdirSync(projectsDir)) {
      const projDir = path.join(projectsDir, projName);
      try {
        if (!fs.statSync(projDir).isDirectory()) continue;
      } catch {
        continue;
      }
      let entries;
      try {
        entries = fs.readdirSync(projDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        // 只读文件头 8KB：cwd 在每条记录顶层，首条记录就有，不必整读
        let head = '';
        try {
          const fd = fs.openSync(path.join(projDir, e.name), 'r');
          const buf = Buffer.alloc(8192);
          const n = fs.readSync(fd, buf, 0, 8192, 0);
          fs.closeSync(fd);
          head = buf.toString('utf8', 0, n);
        } catch {
          continue;
        }
        const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
        if (!m) continue;
        let cwd;
        try {
          cwd = JSON.parse(`"${m[1]}"`);
        } catch {
          continue;
        }
        cwdCount.set(cwd, (cwdCount.get(cwd) || 0) + 1);
      }
    }
  }

  // 系统目录不可能是工作目录，直接剔除，免得污染候选列表
  const SYSTEM_ROOT_RE = /^[A-Za-z]:\\(windows|users|program files|program files \(x86\)|programdata|windows\\system32)$/i;

  // 归纳到「盘符 + 一级目录」作为候选根，并留几个真实 cwd 样本供用户辨认
  const rootCount = new Map();
  const rootSamples = new Map();
  const driveCount = new Map();
  const driveRoots = new Map();
  for (const [cwd, n] of cwdCount) {
    const parts = cwd.split(/[\\/]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const drive = `${parts[0]}\\`;
    driveCount.set(drive, (driveCount.get(drive) || 0) + n);
    if (!driveRoots.has(drive)) driveRoots.set(drive, new Set());
    const root = `${parts[0]}\\${parts[1]}`;
    if (SYSTEM_ROOT_RE.test(root)) continue;
    driveRoots.get(drive).add(root);
    rootCount.set(root, (rootCount.get(root) || 0) + n);
    if (!rootSamples.has(root)) rootSamples.set(root, []);
    const s = rootSamples.get(root);
    if (s.length < 3 && !s.includes(cwd)) s.push(cwd);
  }

  const candidateWorkRoots = [...rootCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([root, sessions]) => ({ root, sessions, sampleCwds: rootSamples.get(root) || [] }));

  // 同一盘下候选根很多时（如存在多个 workspace 副本），把整盘作为一个粗粒度选项报出来，
  // 由用户/模型在「覆盖完全」与「扫描范围」之间取舍
  const driveRollup = [...driveCount.entries()]
    .map(([drive, sessions]) => ({
      drive,
      sessions,
      distinctRoots: driveRoots.get(drive)?.size || 0,
    }))
    .filter((d) => d.distinctRoots >= 3)
    .sort((a, b) => b.sessions - a.sessions);

  const probeStats = {};
  const repos = discoverRepos(
    { workRoots: candidateWorkRoots.map((c) => c.root), scanMaxDepth: 8, excludeRepos: [] },
    probeStats,
  );

  // 按 email 聚合，而不是按署名。同一个人在不同仓库的署名可能不同
  // （实测同一个人可能同时有拼音与中文署名），按署名拆行会让人认不出那是同一个自己。
  const byEmail = new Map();
  for (const repo of repos) {
    const out = sh('git', ['-C', repo, 'log', '-n', '500', `--pretty=%an\x1f%ae`]);
    if (!out) continue;
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const i = line.indexOf('\x1f');
      if (i < 0) continue;
      const name = line.slice(0, i);
      const email = (line.slice(i + 1) || '').trim().toLowerCase();
      if (!email) continue;
      let rec = byEmail.get(email);
      if (!rec) byEmail.set(email, (rec = { email, commits: 0, names: new Map() }));
      rec.commits++;
      rec.names.set(name, (rec.names.get(name) || 0) + 1);
    }
  }

  return {
    skillDir: SKILL_ROOT,
    transcriptDir: projectsDir,
    transcriptExists: fs.existsSync(projectsDir),
    candidateWorkRoots,
    driveRollup,
    reposFound: repos.length,
    authors: [...byEmail.values()]
      .sort((a, b) => b.commits - a.commits)
      .map((r) => ({
        email: r.email,
        commits: r.commits,
        names: [...r.names.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n),
      })),
    hint: 'candidateWorkRoots 按会话数排序；authors 按 email 聚合、按提交数排序——请用户指认哪些 email 属于他本人（同一 email 下的多个签名会一并纳入）。',
  };
}

// ────────────────────────────────────────────────────────────
// main
// ────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));

  // 周归属查询模式：只算目录名与文件名，不扫任何数据
  if (args.weekOf) {
    const d = args.weekOf === 'today' ? todayLocal() : normalizeDate(args.weekOf);
    process.stdout.write(JSON.stringify(weekOf(d), null, 2) + '\n');
    return;
  }

  // 首次配置探测：不读 config.json、不写任何文件，只输出建议
  if (args.init) {
    process.stdout.write(JSON.stringify(await proposeConfig(), null, 2) + '\n');
    return;
  }

  if (!args.date) throw new UsageError('未提供 --date');
  const dateStr = args.date === 'today' ? todayLocal() : normalizeDate(args.date);

  const cfgPath = args.config || path.join(SKILL_ROOT, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    console.error(`配置文件不存在：${cfgPath}`);
    console.error('先跑 `node scripts/extract.mjs --init` 看建议配置，据此创建 config.json。');
    process.exit(3);
  }
  let cfg;
  try {
    cfg = validateConfig(JSON.parse(fs.readFileSync(cfgPath, 'utf8')), cfgPath);
  } catch (e) {
    console.error(e.message);
    process.exit(3);
  }
  // 警告走 stderr：不阻断运行，但要让调用方看见
  for (const w of cfg.__warnings || []) console.error(`⚠ ${w}`);
  const range = dayRange(dateStr);

  const stats = {
    filesScanned: 0, filesParsed: 0, filesSkipped: 0, linesUnparsed: 0,
    reposScanned: 0, promptsFound: 0, commitsFound: 0, docsFound: 0,
  };

  const repos = discoverRepos(cfg, stats);
  const commits = scanGit(cfg, range, repos, stats);
  // 只有「当天有本人提交」的仓库才归 git 侧负责。仓库里可能有未提交的当日产出，
  // 一律按仓库边界排除会连它们一起丢掉。
  const activeRepos = [...new Set(commits.map((c) => c.repo.toLowerCase()))];
  stats.activeRepos = activeRepos.length;
  const sessions = await scanTranscripts(cfg, range, activeRepos, stats);
  const docs = scanDocs(cfg, range, activeRepos, sessions, stats);
  stats.elapsedMs = Date.now() - t0;

  if (args.json) {
    process.stdout.write(JSON.stringify({
      date: dateStr,
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId, cwd: s.cwd,
        firstSeen: hhmm(s.firstMs), lastSeen: hhmm(s.lastMs),
        userPrompts: s.prompts.map((x) => ({ time: hhmm(x.ms), text: x.text })),
        dispatches: s.dispatches.map((x) => ({ time: hhmm(x.ms), tool: x.tool, description: x.description })),
        gitActions: s.gitActions.map((x) => ({ time: hhmm(x.ms), command: x.command })),
        docWrites: s.writes.map((x) => ({ first: hhmm(x.firstMs), last: hhmm(x.lastMs), count: x.count, path: x.path })),
      })),
      commits: commits.map((c) => ({ repo: c.repo, time: hhmm(c.ms), hash: c.hash, authorDate: new Date(c.ms).toISOString(), subject: c.subject })),
      docs: docs.map((d) => ({ path: d.path, mtime: hhmm(d.ms), source: 'fs' })),
      stats,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(renderMarkdown(dateStr, range, sessions, commits, docs, stats));
  }
}

main().catch((e) => {
  if (e instanceof UsageError) {
    console.error(e.message);
    console.error('');
    console.error('用法:');
    console.error('  node extract.mjs --init                          探测建议配置（首次使用）');
    console.error('  node extract.mjs --date 2026-10-12 [--json]      提取当日素材');
    console.error('  node extract.mjs --week-of [日期|today]          查询周目录名与当日文件名');
    process.exit(2);
  }
  console.error(`提取失败：${e.message}`);
  process.exit(1);
});
