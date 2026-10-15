import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  addBrainstormKnowledge,
  appendBrainstormTurn,
  createBrainstormSession,
  listBrainstormSessions,
  parseBrainstormSession,
  readBrainstormSession,
} from "../server/brainstorm.mjs";

let vaultRoot;

before(async () => {
  vaultRoot = await mkdtemp(path.join(os.tmpdir(), "brainstorm-store-"));
});

after(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
});

test("brainstorm sessions round-trip through markdown", async () => {
  const created = await createBrainstormSession(vaultRoot, "retention");
  assert.match(created.session.id, /^20\d{6}-/);
  await appendBrainstormTurn(vaultRoot, created.session.id, {
    role: "user",
    text: "why does it gather dust",
  });
  await appendBrainstormTurn(vaultRoot, created.session.id, {
    role: "assistant",
    text: "trigger frequency.\n- push yesterday digest\n- one reusable conclusion",
  });
  const listed = await listBrainstormSessions(vaultRoot);
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].title, "retention");
  assert.equal(listed.sessions[0].turns, 2);
  const detail = await readBrainstormSession(vaultRoot, created.session.id);
  assert.equal(detail.session.turns.length, 2);
  assert.equal(detail.session.turns[0].role, "user");
  const saved = await addBrainstormKnowledge(
    vaultRoot,
    created.session.id,
    "push yesterday digest",
  );
  assert.match(saved.savedRelativePath, /knowledge-delta\.md$/);
  const delta = await readFile(path.join(vaultRoot, saved.savedRelativePath), "utf8");
  assert.match(delta, /- push yesterday digest/);
  const reread = await readBrainstormSession(vaultRoot, created.session.id);
  assert.deepEqual(reread.knowledgeDelta, ["push yesterday digest"]);
});

test("brainstorm parser tolerates missing front matter", () => {
  const parsed = parseBrainstormSession("# t\n\n## turn 2026-01-01 user\nhi\n");
  assert.equal(parsed.meta.title, undefined);
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].text, "hi");
});

test("brainstorm rejects unsafe session ids", async () => {
  await assert.rejects(readBrainstormSession(vaultRoot, "../etc"));
});
