import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import {
  addBrainstormKnowledge,
  createBrainstormSession,
  loadBrainstormSession,
  loadBrainstormSessions,
  sendBrainstormMessage,
} from "../lib/api";

function splitPropositions(text) {
  const lines = String(text || "").split("\n");
  const prose = [];
  const propositions = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) propositions.push(trimmed.slice(2));
    else if (trimmed) prose.push(trimmed);
  }
  return { prose, propositions };
}

function TurnBlock({ turn, sessionId, onAddKnowledge, added }) {
  const isUser = turn.role === "user";
  const { prose, propositions } = splitPropositions(turn.text);
  return (
    <article className="brainstorm-block">
      <div className="brainstorm-block__title">
        {isUser ? "你" : "AI 研讨"}
      </div>
      {prose.map((line) => (
        <p key={line.slice(0, 40)}>{line}</p>
      ))}
      {propositions.length ? (
        <div className="brainstorm-propositions">
          {propositions.map((item) => (
            <article key={item.slice(0, 40)}>
              <div>{item}</div>
              {!isUser ? (
                <div className="brainstorm-artifacts">
                  <button
                    disabled={added.has(item)}
                    onClick={() => onAddKnowledge(sessionId, item)}
                    type="button"
                  >
                    {added.has(item) ? "已加入知识库" : "加入知识库"}
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function BrainstormPage() {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [topic, setTopic] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [added, setAdded] = useState(() => new Set());

  const refreshSessions = useCallback(async () => {
    try {
      const payload = await loadBrainstormSessions();
      setSessions(payload.sessions || []);
    } catch (cause) {
      setError(cause?.message || "会话列表加载失败");
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (!activeId) {
      setDetail(null);
      return undefined;
    }
    let cancelled = false;
    loadBrainstormSession(activeId)
      .then((payload) => {
        if (!cancelled) setDetail(payload);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause?.message || "会话加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  async function startSession() {
    if (!topic.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await createBrainstormSession(topic);
      setActiveId(payload.session.id);
      setTopic("");
      await refreshSessions();
    } catch (cause) {
      setError(cause?.message || "创建会话失败");
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage() {
    const text = draft.trim();
    if (!text || !activeId || busy) return;
    setBusy(true);
    setError(null);
    setDraft("");
    try {
      const payload = await sendBrainstormMessage(activeId, text);
      setDetail({
        session: payload.session,
        knowledgeDelta: detail?.knowledgeDelta || [],
      });
      await refreshSessions();
    } catch (cause) {
      setError(cause?.message || "发送失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddKnowledge(sessionId, text) {
    try {
      await addBrainstormKnowledge(sessionId, text);
      setAdded((prev) => new Set(prev).add(text));
      const payload = await loadBrainstormSession(sessionId);
      setDetail(payload);
    } catch (cause) {
      setError(cause?.message || "加入知识库失败");
    }
  }

  const session = detail?.session || null;

  return (
    <div className="page--brainstorm">
      <PageHeader
        eyebrow="BRAINSTORM · LOCAL SESSION"
        title="头脑风暴"
        description="页面内直接和 AI 研讨。有效结论一键加入知识库，沉淀为可回看的会话档案。"
      />
      {error ? <p className="brainstorm-empty">{error}</p> : null}

      {!activeId ? (
        <div className="brainstorm-start">
          <div className="brainstorm-start__mark" aria-hidden="true" />
          <h2>开始一场研讨</h2>
          <textarea
            onChange={(event) => setTopic(event.target.value)}
            placeholder="例如：为什么我的个人工作台容易吃灰？从触发、行动、回报三环拆解。"
            rows={4}
            value={topic}
          />
          <button disabled={!topic.trim() || busy} onClick={startSession} type="button">
            {busy ? "创建中…" : "开始研讨"}
          </button>
        </div>
      ) : (
        <div className="brainstorm-workspace">
          <aside className="brainstorm-history">
            <div className="brainstorm-history__head">会话档案</div>
            <div className="brainstorm-session-list">
              {sessions.length === 0 ? (
                <p className="brainstorm-empty">还没有会话。</p>
              ) : (
                sessions.map((item) => (
                  <button
                    className={`brainstorm-session${item.id === activeId ? " brainstorm-session--active" : ""}`}
                    key={item.id}
                    onClick={() => setActiveId(item.id)}
                    type="button"
                  >
                    <strong>{item.title}</strong>
                    <span className="brainstorm-session__status">
                      {item.status}
                    </span>
                    <time>{String(item.updatedAt || "").slice(0, 10)}</time>
                    <span>{item.turns} 条发言</span>
                  </button>
                ))
              )}
            </div>
          </aside>

          <section className="brainstorm-detail">
            <div className="brainstorm-detail__head">
              <div>
                <h2>{session?.title || "研讨中"}</h2>
                <p>
                  {session
                    ? `${session.turns?.length || 0} 条发言 · 状态 ${session.status || "active"}`
                    : "加载中…"}
                </p>
              </div>
              <button onClick={() => setActiveId(null)} type="button">
                新会话
              </button>
            </div>

            {session && session.turns?.length ? (
              session.turns.map((turn, index) => (
                <TurnBlock
                  added={added}
                  key={`${turn.at}-${index}`}
                  onAddKnowledge={handleAddKnowledge}
                  sessionId={activeId}
                  turn={turn}
                />
              ))
            ) : (
              <p className="brainstorm-detail-placeholder">
                会话已建立。发出第一条发言，AI 会在本页直接回应。
              </p>
            )}

            {detail?.knowledgeDelta?.length ? (
              <div className="brainstorm-artifacts">
                {detail.knowledgeDelta.map((line) => (
                  <button disabled key={line} type="button">
                    已入库：{line}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="brainstorm-composer">
              <textarea
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder="继续研讨… Enter 发送，Shift+Enter 换行"
                rows={3}
                value={draft}
              />
              <button
                disabled={!draft.trim() || busy}
                onClick={sendMessage}
                type="button"
              >
                {busy ? "思考中…" : "发送"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
