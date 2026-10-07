import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_EXECUTION_POLICY_CONFIG, type Instant, isPersonOnlyAppIntent, isPersonOnlyRoute } from "@clarkcant/contracts";
import { setPreference } from "@clarkcant/core";
import { type Database, MIGRATIONS, createConversation, getConversation, insertAttachment, insertBrokerArtifact, migrate, openDatabase, transaction } from "@clarkcant/storage";
import { decideAppIntent, mintConfirmation, consumeConfirmation } from "../src/app-intents.ts";
import { deleteConversation, grantConversationDeletion } from "../src/application/conversation-delete.ts";
import { writeBlob } from "../src/blobs.ts";
import { releaseConversationAttachments } from "../src/attachments.ts";
import { sweepConversationFileCleanup } from "../src/conversation-file-cleanup.ts";
import { beginActionRun, endActionRun } from "../src/application/action-runs.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

const AT = "2026-09-30T09:00:00.000Z" as Instant;
let db: Database;
let dir: string;
let now: Instant;
const id = "conv_delete";
const owner = "prin_owner";
const nodeId = "node_local";
const deps = () => ({db, dataDir: dir, nodeId, principalId: owner, now: () => now, newId: (prefix: string) => `${prefix}_test`});
const mint = (intent: Parameters<typeof mintConfirmation>[1]["intent"]) => mintConfirmation(deps(), {principalId: owner, intent, source: "chat"});
const remove = (deletionPermit?: string) => deleteConversation(deps(), {conversationId: id, locale: "en", mint, ...(deletionPermit === undefined ? {} : {deletionPermit})});
function policy(mode: "ask" | "guarded" | "autonomous", deny = false) {
  setPreference(deps(), {principalId: owner, key: "execution.policy", scope: "global", source: "user", value: {...DEFAULT_EXECUTION_POLICY_CONFIG, mode, rules: deny ? [{effectCategory: "destructive", decision: "deny"}] : []}});
}
function attachment(name = "att_1", conversationId = id, content = "real retained bytes") {
  const bytes = new TextEncoder().encode(content);
  const blob = writeBlob({dataDir: dir, bytes, extension: "txt"});
  insertAttachment(db, {attachmentId: name, principalId: owner, conversationId, filename: "note.txt", mime: "text/plain", kind: "text", sizeBytes: bytes.length, sha256: blob.digest, blobPath: blob.blobPath, createdAt: AT});
  return blob;
}
function artifact() {
  const bytes = new TextEncoder().encode("widget's finalized file, never attached");
  const blob = writeBlob({dataDir: dir, bytes, extension: "txt"});
  insertBrokerArtifact(db, {artifactId: "art_final", ownerPrincipalId: owner, kind: "finalized", state: "sealed", conversationId: id, instanceId: "wi_private", name: "final.txt", mimeType: "text/plain", sizeBytes: bytes.length, digest: blob.digest, blobPath: blob.blobPath, stagingRef: undefined, createdAt: AT, expiresAt: undefined, originNodeId: nodeId});
  return blob;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-delete-")); db = openDatabase({path: ":memory:"}); migrate(db); now = AT;
  createConversation(db, {conversationId: id, homeNodeId: nodeId, at: AT}); policy("autonomous");
});
afterEach(async () => { db.close(); await removeTestDirectory(dir); });

it("releases attachments and finalized unattached widget files only after commit, preserving shared bytes", () => {
  const shared = attachment(); const exclusive = artifact();
  createConversation(db, {conversationId: "conv_kept", homeNodeId: nodeId, at: AT}); attachment("att_shared", "conv_kept");
  const result = remove();
  expect(result).toMatchObject({deleted: true, attachments: 1, artifacts: 1, pendingFiles: 0});
  expect(getConversation(db, id)).toBeUndefined(); expect(getConversation(db, "conv_kept")).toBeDefined();
  expect(existsSync(shared.blobPath)).toBe(true); expect(existsSync(exclusive.blobPath)).toBe(false);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it.each(["artifacts", "conversations"])("rolls back rows and bytes when deletion fails at %s", (table) => {
  const a = attachment(); const b = artifact();
  db.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'disk fault'); END`);
  expect(remove()).toMatchObject({deleted: false, decision: {kind: "refused"}});
  expect(getConversation(db, id)).toBeDefined();
  expect(db.prepare("SELECT * FROM attachments").all()).toHaveLength(1); expect(db.prepare("SELECT * FROM artifacts").all()).toHaveLength(1);
  expect(db.prepare("SELECT * FROM conversation_file_cleanup").all()).toHaveLength(0);
  expect(existsSync(a.blobPath)).toBe(true); expect(existsSync(b.blobPath)).toBe(true);
});

it("removes the four restrictive foreign-key owners and their private widget without turning off foreign keys", () => {
  db.prepare("INSERT INTO tasks(task_id,conversation_id,home_node_id,state,disposition,revision,goal,created_at,updated_at) VALUES (?,?,?,'cancelled','done',1,'completed work',?,?)").run("task_done", id, nodeId, AT, AT);
  db.prepare("INSERT INTO widget_instances(instance_id,definition_id,definition_version,package_digest,owner_node_id,owner_principal_id,revision,presentation_revision,data_revision,action_binding_revision,lifecycle,document,updated_at) VALUES ('wi_private','clarkcant.table@1','1.0.0','digest',?,?,1,1,1,1,'active','{}',?)").run(nodeId, owner, AT);
  db.prepare("INSERT INTO pins(pin_id,conversation_id,instance_id,display_mode,position,refresh_policy,created_at) VALUES ('pin_delete',?,'wi_private','expanded',0,'manual',?)").run(id, AT);
  db.prepare("INSERT INTO messages(message_id,conversation_id,role,author_node_id,delivery,document,sequence,created_at) VALUES ('msg_delete',?,'user',?,'delivered','{}',1,?)").run(id, nodeId, AT);
  artifact();
  expect(remove()).toMatchObject({deleted: true});
  for (const table of ["conversations", "conversation_authority", "tasks", "pins", "messages", "widget_instances"]) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("reports locked bytes as pending and retries the durable cleanup without resurrecting deleted rows", () => {
  const a = attachment(); rmSync(a.blobPath); mkdirSync(a.blobPath);
  expect(remove()).toMatchObject({deleted: true, pendingFiles: 1});
  expect(getConversation(db, id)).toBeUndefined(); expect(existsSync(a.blobPath)).toBe(true);
  rmdirSync(a.blobPath); writeFileSync(a.blobPath, "released lock");
  expect(sweepConversationFileCleanup(deps())).toEqual({pending: 0}); expect(existsSync(a.blobPath)).toBe(false);
});

it("keeps data while a widget action is aborting or a model turn still holds the conversation", () => {
  attachment();
  const controller = beginActionRun({invocationId: "inv_delete", conversationId: id});
  try {
    controller?.abort();
    expect(remove()).toMatchObject({deleted: false, decision: {kind: "refused"}});
  } finally { endActionRun("inv_delete"); }
  expect(deleteConversation({...deps(), runningConversations: () => [id]}, {conversationId: id, locale: "en", mint})).toMatchObject({deleted: false});
  expect(getConversation(db, id)).toBeDefined(); expect(remove()).toMatchObject({deleted: true});
});

it("does not let the standalone release helper unlink files inside a caller's transaction", () => {
  const a = attachment();
  expect(() => transaction(db, () => releaseConversationAttachments({...deps(), conversationId: id}))).toThrow("wait for commit");
  expect(existsSync(a.blobPath)).toBe(true); expect(db.prepare("SELECT * FROM attachments").all()).toHaveLength(1);
});

it("asks through policy, keeps data on denial, and spends a principal-bound permission exactly once", () => {
  policy("guarded"); attachment();
  const first = remove(); expect(first).toMatchObject({deleted: false, decision: {kind: "needs-confirmation"}});
  if (first.deleted || first.decision.kind !== "needs-confirmation") throw new Error("missing policy question");
  const outcome = consumeConfirmation(deps(), {principalId: owner, token: first.decision.confirmationToken});
  if (!outcome.ok) throw new Error("missing confirmation");
  const granted = grantConversationDeletion(deps(), outcome.intent, "en");
  if (granted.kind !== "intent") throw new Error("missing permit");
  const permit = granted.intent.deletionPermit;
  expect(deleteConversation({...deps(), principalId: "prin_other"}, {conversationId: id, locale: "en", mint, deletionPermit: permit!})).toMatchObject({deleted: false});
  expect(remove(permit)).toMatchObject({deleted: true});
  expect(db.prepare("SELECT consumed_at FROM conversation_delete_permissions").get()).toMatchObject({consumed_at: AT});
  expect(remove(permit)).toMatchObject({deleted: false});
});

it.each(["expired", "wrong-target", "tightened-policy"])("keeps all data with a %s permission", (reason) => {
  policy("ask"); attachment();
  const granted = grantConversationDeletion(deps(), {kind: "conversation.delete", conversationId: reason === "wrong-target" ? "conv_other" : id}, "en");
  if (reason === "wrong-target") {
    expect(granted.kind).toBe("refused");
    createConversation(db, {conversationId: "conv_other", homeNodeId: nodeId, at: AT});
    const other = grantConversationDeletion(deps(), {kind: "conversation.delete", conversationId: "conv_other"}, "en");
    if (other.kind !== "intent") throw new Error("missing permit");
    expect(remove(other.intent.deletionPermit)).toMatchObject({deleted: false});
  }
  else {
    if (granted.kind !== "intent") throw new Error("missing permit");
    if (reason === "expired") now = "2026-09-30T09:03:00.000Z" as Instant;
    else policy("autonomous", true);
    expect(remove(granted.intent.deletionPermit)).toMatchObject({deleted: false});
  }
  expect(getConversation(db, id)).toBeDefined(); expect(db.prepare("SELECT * FROM attachments").all()).toHaveLength(1);
});

it.each(["chat", "voice"] as const)("binds the %s command to the current conversation and asks the same policy", (source) => {
  policy("guarded");
  const decision = decideAppIntent(deps(), {principalId: owner, conversationId: id as never, request: {text: "delete this conversation", source}}, mint);
  expect(decision).toMatchObject({kind: "needs-confirmation", intent: {kind: "conversation.delete", conversationId: id}});
});

it("refuses agent intents and machine relays, including alternate path segmentation", () => {
  expect(isPersonOnlyAppIntent("conversation.delete")).toBe(true);
  for (const path of ["/conversations/conv_delete/delete", "//conversations//conv_delete//delete?x=1"]) expect(isPersonOnlyRoute("POST", path)).toBe(true);
  for (const source of ["agent", "voice-agent"] as const) expect(decideAppIntent(deps(), {principalId: owner, conversationId: id as never, request: {text: "delete this conversation", source}}, mint)).toMatchObject({kind: "refused"});
});

it("upgrades a populated schema 38 without rewriting applied migrations or disabling foreign keys", () => {
  const legacy = openDatabase({path: ":memory:"}); migrate(legacy, MIGRATIONS.slice(0, 38));
  createConversation(legacy, {conversationId: id, homeNodeId: nodeId, at: AT});
  expect(migrate(legacy).applied).toEqual([39, 40, 41, 42, 43, 44, 45]); expect(getConversation(legacy, id)).toBeDefined();
  expect(legacy.prepare("PRAGMA foreign_keys").get()).toMatchObject({foreign_keys: 1}); legacy.close();
});
