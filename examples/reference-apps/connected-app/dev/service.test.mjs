/*
 * The service against the fake connector, with a stand-in for the node. Run with `node --test test/`.
 *
 * Portable on purpose: a package scaffolded with `clark widget init --template connected-app` keeps this file and runs
 * it as it is. It proves what the service sends and how it reads what comes back; `clark widget test` proves the
 * package, and the node's own tests prove the broker.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startFakeConnector } from "./fake-connector.mjs";
import { connectToFake, declaredConnection, startService } from "./service-harness.mjs";

describe("the connected app's service", () => {
  let connector;
  const declared = declaredConnection().endpoints[0];
  const rebase = (url) => url.replace(declared, connector.origin);

  before(async () => {
    connector = await startFakeConnector();
  });
  after(async () => {
    await connector.close();
  });

  it("lists the tasks with the token the node adds, and never sends one of its own", async () => {
    const grant = await connectToFake(connector);
    const service = startService({ token: async () => grant.access_token, rebase });
    try {
      const listed = await service.call("list-tasks");
      assert.equal(listed.isError, false);
      assert.ok(JSON.parse(listed.text).tasks.length > 0);
      for (const request of service.egressRequests) {
        assert.equal(Object.keys(request.headers ?? {}).some((name) => name.toLowerCase() === "authorization"), false);
        assert.equal(new URL(request.url).origin, declared);
      }
    } finally {
      service.stop();
    }
  });

  it("renames a task once", async () => {
    const grant = await connectToFake(connector);
    const service = startService({ token: async () => grant.access_token, rebase });
    try {
      const before = connector.stats().writes;
      const renamed = await service.call("update-task", { id: "task-1", title: "Báo cáo tuần đã xong" });
      assert.equal(renamed.isError, false);
      assert.equal(JSON.parse(renamed.text).task.title, "Báo cáo tuần đã xong");
      assert.equal(connector.stats().writes, before + 1);
    } finally {
      service.stop();
    }
  });

  it("says which scope is missing when the account did not grant it", async () => {
    const grant = await connectToFake(connector, { scopes: ["tasks.read"] });
    const service = startService({ token: async () => grant.access_token, rebase });
    try {
      const refused = await service.call("update-task", { id: "task-1", title: "Không được" });
      assert.equal(refused.isError, true);
      assert.match(refused.text, /tasks\.write/);
    } finally {
      service.stop();
    }
  });

  it("asks to reconnect when the provider no longer accepts the connection", async () => {
    const grant = await connectToFake(connector);
    connector.revokeAll();
    const service = startService({ token: async () => grant.access_token, rebase });
    try {
      const refused = await service.call("list-tasks");
      assert.equal(refused.isError, true);
      assert.match(refused.text, /reconnect it in Settings/);
    } finally {
      service.stop();
    }
  });

  it("does not send a call the node refused to sign", async () => {
    const service = startService({ token: async () => undefined, rebase });
    try {
      const refused = await service.call("list-tasks");
      assert.equal(refused.isError, true);
      assert.match(refused.text, /not sent/);
    } finally {
      service.stop();
    }
  });
});
