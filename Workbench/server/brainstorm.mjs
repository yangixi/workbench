import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { CODEX_EXEC_ARGS, detectCodexCli } from "./codex-runner.mjs";

const SESSION_ROOT = path.join("Brainstorm", "session");
const AI_MODE_ENV = "WORKBENCH_BRAINSTORM_AI";
const REPLY_TIMEOUT_MS = 4 * 60 * 1000;
const MAX_BRIEF_CHARS = 4000;

const nowIso = () => new Date().toISOString();

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function slugify(topic) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const clean =
    topic
      .trim()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "session";
  return `${stamp}-${clean}`;
}

function frontMatter(fields) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}\n`;
}

export function parseBrainstormSession(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const meta = {};
  let cursor = 0;
  if (lines[0] === "---") {
    cursor = 1;
    while (cursor < lines.length && lines[cursor] !== "---") {
      const split = lines[cursor].indexOf(":");
      if (split > 0) {
        meta[lines[cursor].slice(0, split).trim()] = lines[cursor]
          .slice(split + 1)
          .trim();
      }
      cursor += 1;
    }
    cursor += 1;
  }
  const turns = [];
  let current = null;
  for (const line of lines.slice(cursor)) {
    const match = /^## turn (\S+) (user|assistant)\s*$/.exec(line);
    if (match) {
      current = { role: match[2], at: match[1], text: [] };
      turns.push(current);
      continue;
    }
    if (current) current.text.push(line);
  }
  return {
    meta,
    turns: turns.map((turn) => ({
      role: turn.role,
      at: turn.at,
      text: turn.text.join("\n").trim(),
    })),
  };
}

function serializeBrainstormSession({ meta, turns }) {
  const body = turns
    .map((turn) => `## turn ${turn.at} ${turn.role}\n${turn.text}\n`)
    .join("\n");
  return `${frontMatter(meta)}# ${meta.title}\n\n${body}`;
}

function assertSessionId(sessionId) {
  if (!/^[\p{L}\p{N}_-]+$/u.test(sessionId || "")) {
    const error = new Error("会话 ID 不合法。");
    error.code = "BRAINSTORM_BAD_ID";
    throw error;
  }
}

function sessionFile(vaultRoot, sessionId) {
  return path.join(vaultRoot, SESSION_ROOT, sessionId, "brainstorm.md");
}

function knowledgeFile(vaultRoot, sessionId) {
  return path.join(vaultRoot, SESSION_ROOT, sessionId, "knowledge-delta.md");
}

export async function listBrainstormSessions(vaultRoot) {
  let entries = [];
  try {
    entries = await readdir(path.join(vaultRoot, SESSION_ROOT), {
      withFileTypes: true,
    });
  } catch {
    return { sessions: [] };
  }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile(
        path.join(vaultRoot, SESSION_ROOT, entry.name, "brainstorm.md"),
        "utf8",
      );
      const { meta, turns } = parseBrainstormSession(raw);
      sessions.push({
        id: entry.name,
        title: meta.title || entry.name,
        status: meta.status || "active",
        updatedAt: meta.updated || meta.created || null,
        turns: turns.length,
      });
    } catch {
      // 损坏的会话目录保持缺失，不用虚构数据顶替。
    }
  }
  sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { sessions };
}

export async function readBrainstormSession(vaultRoot, sessionId) {
  assertSessionId(sessionId);
  const raw = await readFile(sessionFile(vaultRoot, sessionId), "utf8");
  const { meta, turns } = parseBrainstormSession(raw);
  return {
    session: { id: sessionId, ...meta, turns },
    knowledgeDelta: await readKnowledgeDelta(vaultRoot, sessionId),
  };
}

export async function createBrainstormSession(vaultRoot, topic) {
  const title = String(topic || "").trim();
  if (!title) {
    const error = new Error("研讨主题不能为空。");
    error.code = "BRAINSTORM_EMPTY_TOPIC";
    throw error;
  }
  const id = slugify(title);
  const at = nowIso();
  const meta = {
    title,
    type: "brainstorm-session",
    status: "active",
    created: at,
    updated: at,
  };
  const file = sessionFile(vaultRoot, id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, serializeBrainstormSession({ meta, turns: [] }), "utf8");
  return { session: { id, ...meta, turns: [] } };
}

export async function appendBrainstormTurn(vaultRoot, sessionId, turn) {
  assertSessionId(sessionId);
  const file = sessionFile(vaultRoot, sessionId);
  const { meta, turns } = parseBrainstormSession(await readFile(file, "utf8"));
  turns.push({
    role: turn.role === "user" ? "user" : "assistant",
    at: nowIso(),
    text: String(turn.text || "").trim(),
  });
  meta.updated = nowIso();
  await writeFile(file, serializeBrainstormSession({ meta, turns }), "utf8");
  return { session: { id: sessionId, ...meta, turns } };
}

export async function addBrainstormKnowledge(vaultRoot, sessionId, text) {
  assertSessionId(sessionId);
  const line = String(text || "").trim();
  if (!line) {
    const error = new Error("结论不能为空。");
    error.code = "BRAINSTORM_EMPTY_CONCLUSION";
    throw error;
  }
  const file = knowledgeFile(vaultRoot, sessionId);
  let content = "";
  try {
    content = await readFile(file, "utf8");
  } catch {
    content = "";
  }
  if (!content.trim()) {
    content = `${frontMatter({
      type: "knowledge-delta",
      session: sessionId,
      updated: nowIso(),
    })}# 知识增量\n\n`;
  }
  content += `- ${line}\n`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return {
    savedRelativePath: toPosix(path.relative(vaultRoot, file)),
  };
}

async function readKnowledgeDelta(vaultRoot, sessionId) {
  try {
    const raw = await readFile(knowledgeFile(vaultRoot, sessionId), "utf8");
    return raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2));
  } catch {
    return [];
  }
}

function extractAgentMessage(event) {
  if (
    event?.type === "item.completed" &&
    event?.item?.type === "agent_message" &&
    typeof event.item.text === "string"
  ) {
    return event.item.text;
  }
  if (
    event?.type === "message.completed" &&
    event?.message?.role === "assistant" &&
    typeof event.message.content === "string"
  ) {
    return event.message.content;
  }
  if (
    event?.type === "response.completed" &&
    typeof event?.response?.output_text === "string"
  ) {
    return event.response.output_text;
  }
  return null;
}

function noticeReply(detail, userText) {
  const parts = ["【未接入 AI 后端】公开版默认不内置模型调用，本条为占位回复。"];
  if (detail) parts.push(detail);
  parts.push(
    "安装 Codex CLI 后保持 WORKBENCH_BRAINSTORM_AI 为默认值即可改为真实研讨；设为 off 可关闭尝试。",
  );
  if (userText) parts.push(`已记录你的发言：${userText.slice(0, 160)}`);
  return { role: "assistant", text: parts.join(" "), backend: "notice" };
}

function runCodexBrief(executablePath, brief) {
  return new Promise((resolve) => {
    const child = spawn(executablePath, [...CODEX_EXEC_ARGS, brief], {
      cwd: process.cwd(),
    });
    let buffer = "";
    let latest = null;
    const timer = setTimeout(() => child.kill("SIGTERM"), REPLY_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const message = extractAgentMessage(JSON.parse(trimmed));
          if (message) latest = message;
        } catch {
          // 非 JSON 行直接忽略。
        }
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, detail: "无法启动 Codex CLI。" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (latest) resolve({ ok: true, text: latest });
      else resolve({ ok: false, detail: `Codex 退出码 ${code}，未取得回复。` });
    });
  });
}

export async function brainstormReply(vaultRoot, sessionId, userText) {
  if (process.env[AI_MODE_ENV] === "off") {
    return noticeReply("WORKBENCH_BRAINSTORM_AI=off。", userText);
  }
  if (process.env[AI_MODE_ENV] === "demo") {
    return {
      role: "assistant",
      backend: "demo",
      text: [
        "判断：吃灰的根因通常是回报环缺失，而不是功能不足。",
        "- 把回看变成被推送：总览页每天给一条昨日新增与旧知识的配对",
        "- 每次回看必须产出一条可复制结论，否则视为无效回看",
        "- 用触发频率而非功能数量评估工作台健康度",
      ].join("\n"),
    };
  }
  const cli = await detectCodexCli();
  if (!cli.available) {
    return noticeReply(cli.reason || null, userText);
  }
  const history = await readBrainstormSession(vaultRoot, sessionId).catch(
    () => null,
  );
  const context = (history?.session?.turns || [])
    .slice(-6)
    .map((turn) => `${turn.role === "user" ? "用户" : "AI"}：${turn.text}`)
    .join("\n");
  const brief = [
    "你是个人 AI 工作台里的头脑风暴伙伴，服务于一位自媒体创作者。",
    "只输出中文研讨回复：先给一句判断，再给最多三条可执行结论，每条单独一行并以“- ”开头。",
    "不要编造 Vault 中不存在的数据。",
    context ? `近期对话：\n${context}` : "",
    `用户最新发言：${String(userText).slice(0, MAX_BRIEF_CHARS)}`,
  ]
    .filter(Boolean)
    .join("\n");
  const result = await runCodexBrief(cli.executablePath, brief);
  if (!result.ok) return noticeReply(result.detail, userText);
  return { role: "assistant", text: result.text, backend: "codex" };
}
