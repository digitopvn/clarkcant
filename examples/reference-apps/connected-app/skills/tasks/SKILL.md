---
name: connected-tasks
description: List or rename tasks in the account the person connected to the Connected tasks package.
---

# Connected tasks

Use the package's capabilities through `invoke_capability`; never ask the person for a password, token or code.

- To see the tasks, invoke `com.clarkcant.reference.connected-app.list-tasks@1` with `{}`. It answers JSON:
  `{ "tasks": [{ "id", "title", "done" }] }`.
- To rename one, invoke `com.clarkcant.reference.connected-app.update-task@1` with `{ "id", "title" }`. It is an
  external write: the node may ask the person first.
- When a capability is not ready, say the reason the node gives (for example that the connection was revoked or did
  not grant `tasks.write`) and point the person to Settings to reconnect. Do not try another way round it.
- When a rename's outcome is unknown, say so. Do not send it again; ask the person to check the task instead.
