import type { Database } from "./db.ts";
import { transaction } from "./db.ts";

/**
 * Schema migrations.
 *
 * Migrations are numbered, forward-only, and applied inside a transaction each.
 * The schema version lives in SQLite's own `user_version` pragma rather than a
 * metadata table, so a half-created metadata table can never be the reason a
 * database cannot be opened.
 *
 * Irreversibility is tracked explicitly: `reversible: false` migrations are the
 * ones that cannot be undone by restoring an older binary, and the operations
 * guide requires that distinction before an upgrade is attempted
 * (docs/distributed-runtime.md §11).
 */

export interface Migration {
  version: number;
  name: string;
  reversible: boolean;
  up: (db: Database) => void;
}

/**
 * Ordering matters and is asserted at load time: a duplicate or out-of-order
 * version would otherwise apply migrations in an arbitrary sequence.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "principals-nodes-grants",
    reversible: true,
    up: (db) => {
      db.exec(`
        CREATE TABLE nodes (
          node_id           TEXT PRIMARY KEY,
          label             TEXT NOT NULL,
          public_key        TEXT,
          fingerprint       TEXT,
          created_at        TEXT NOT NULL,
          revoked_at        TEXT
        );

        CREATE TABLE principals (
          principal_id      TEXT PRIMARY KEY,
          kind              TEXT NOT NULL,
          node_id           TEXT NOT NULL REFERENCES nodes(node_id),
          display_name      TEXT,
          created_at        TEXT NOT NULL
        );

        -- Grants are stored as validated JSON documents: the shape is owned by
        -- packages/contracts and validating here would duplicate it. What the
        -- database enforces is identity and the fields looked up on every call.
        CREATE TABLE grants (
          grant_id          TEXT PRIMARY KEY,
          owner_principal_id TEXT NOT NULL,
          sender_node_id    TEXT NOT NULL,
          receiver_node_id  TEXT NOT NULL,
          document          TEXT NOT NULL,
          expires_at        TEXT NOT NULL,
          revoked_at        TEXT,
          created_at        TEXT NOT NULL
        );
        CREATE INDEX idx_grants_pair ON grants(sender_node_id, receiver_node_id);
        CREATE INDEX idx_grants_expiry ON grants(expires_at);
      `);
    },
  },
  {
    version: 2,
    name: "commands-events-outbox-inbox",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- Durable idempotency. A resent command with the same key returns the
        -- outcome already recorded here instead of creating a second task (T01).
        CREATE TABLE commands (
          command_id        TEXT PRIMARY KEY,
          idempotency_key   TEXT NOT NULL,
          payload_digest    TEXT NOT NULL,
          kind              TEXT NOT NULL,
          conversation_id   TEXT,
          task_id           TEXT,
          accepted_sequence INTEGER NOT NULL,
          ack               TEXT NOT NULL,
          received_at       TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_commands_idempotency ON commands(idempotency_key);

        -- The node's own event log. source_sequence is monotonic per stream and
        -- is what a reconnecting client replays from (envelope.ts cursor).
        CREATE TABLE events (
          event_id          TEXT PRIMARY KEY,
          source_node_id    TEXT NOT NULL,
          stream            TEXT NOT NULL,
          source_sequence   INTEGER NOT NULL,
          kind              TEXT NOT NULL,
          conversation_id   TEXT,
          task_id           TEXT,
          run_id            TEXT,
          document          TEXT NOT NULL,
          occurred_at       TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_events_stream_sequence
          ON events(source_node_id, stream, source_sequence);
        CREATE INDEX idx_events_conversation ON events(conversation_id, source_sequence);
        CREATE INDEX idx_events_task ON events(task_id, source_sequence);

        -- Intent recorded before transmission. A row leaving this table means the
        -- peer acknowledged; it is not deleted on send, because a lost
        -- acknowledgement must not erase the fact that we tried.
        CREATE TABLE outbox (
          message_id        TEXT PRIMARY KEY,
          peer_node_id      TEXT NOT NULL,
          correlation_id    TEXT NOT NULL,
          document          TEXT NOT NULL,
          attempts          INTEGER NOT NULL DEFAULT 0,
          last_attempt_at   TEXT,
          acknowledged_at   TEXT,
          created_at        TEXT NOT NULL
        );
        CREATE INDEX idx_outbox_pending ON outbox(peer_node_id, acknowledged_at);

        -- At-least-once delivery means replays are normal. The primary key is the
        -- dedup identity, so a replay is an insert conflict rather than a second
        -- accepted instruction.
        CREATE TABLE inbox (
          dedup_key         TEXT PRIMARY KEY,
          peer_node_id      TEXT NOT NULL,
          source_sequence   INTEGER NOT NULL,
          message_id        TEXT NOT NULL,
          kind              TEXT NOT NULL,
          document          TEXT NOT NULL,
          response          TEXT,
          received_at       TEXT NOT NULL
        );
        CREATE INDEX idx_inbox_peer_sequence ON inbox(peer_node_id, source_sequence);

        -- Highest contiguous sequence seen per peer, for gap detection (T03).
        CREATE TABLE peer_cursors (
          peer_node_id      TEXT PRIMARY KEY,
          last_sequence     INTEGER NOT NULL,
          updated_at        TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    name: "tasks-runs-effects",
    reversible: true,
    up: (db) => {
      db.exec(`
        CREATE TABLE conversations (
          conversation_id   TEXT PRIMARY KEY,
          title             TEXT,
          home_node_id      TEXT NOT NULL,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );

        -- One home authority per conversation. The unique index on
        -- (conversation_id) in conversation_authority is what makes a second
        -- authority a database error rather than a race (T04).
        CREATE TABLE conversation_authority (
          conversation_id   TEXT PRIMARY KEY REFERENCES conversations(conversation_id),
          home_node_id      TEXT NOT NULL,
          claimed_at        TEXT NOT NULL
        );

        CREATE TABLE tasks (
          task_id           TEXT PRIMARY KEY,
          conversation_id   TEXT NOT NULL REFERENCES conversations(conversation_id),
          home_node_id      TEXT NOT NULL,
          execution_node_id TEXT,
          state             TEXT NOT NULL,
          disposition       TEXT NOT NULL,
          revision          INTEGER NOT NULL,
          goal              TEXT NOT NULL,
          parked_reason     TEXT,
          waiting_capability_ref TEXT,
          waiting_install_plan_id TEXT,
          active_run_id     TEXT,
          budget            TEXT,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );
        CREATE INDEX idx_tasks_conversation ON tasks(conversation_id, updated_at);
        CREATE INDEX idx_tasks_state ON tasks(state);

        CREATE TABLE runs (
          run_id            TEXT PRIMARY KEY,
          task_id           TEXT NOT NULL REFERENCES tasks(task_id),
          task_revision     INTEGER NOT NULL,
          execution_node_id TEXT NOT NULL,
          lease_epoch       INTEGER NOT NULL,
          replaces_run_id   TEXT,
          started_at        TEXT NOT NULL,
          ended_at          TEXT,
          document          TEXT NOT NULL
        );
        CREATE INDEX idx_runs_task ON runs(task_id, started_at);

        CREATE TABLE evidence (
          evidence_id       TEXT PRIMARY KEY,
          -- Nullable: evidence can be recorded for a task whose run has not been
          -- assigned yet, and forcing a placeholder run id would violate the FK.
          run_id            TEXT REFERENCES runs(run_id),
          kind              TEXT NOT NULL,
          verdict           TEXT NOT NULL,
          summary           TEXT NOT NULL,
          ref               TEXT,
          digest            TEXT,
          observed_at       TEXT NOT NULL
        );
        CREATE INDEX idx_evidence_run ON evidence(run_id);

        -- The effect ledger. 'unknown' is a resting state: a submit whose outcome
        -- was never observed stays here until reconciliation resolves it, and
        -- mayRetrySubmit() refuses to re-send it (T05).
        CREATE TABLE effects (
          effect_id         TEXT PRIMARY KEY,
          task_id           TEXT NOT NULL REFERENCES tasks(task_id),
          run_id            TEXT,
          executor_node_id  TEXT NOT NULL,
          category          TEXT NOT NULL,
          capability_ref    TEXT NOT NULL,
          external_idempotency_key TEXT,
          external_supports_dedup INTEGER NOT NULL,
          state             TEXT NOT NULL,
          intent            TEXT NOT NULL,
          operation_digest  TEXT NOT NULL,
          prepared_at       TEXT NOT NULL,
          submitted_at      TEXT,
          settled_at        TEXT,
          resolution        TEXT,
          reconciliation_evidence TEXT,
          submit_attempts   INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_effects_task ON effects(task_id);
        CREATE INDEX idx_effects_unsettled ON effects(state)
          WHERE state IN ('prepared','submitted','unknown');

        CREATE TABLE approvals (
          approval_id       TEXT PRIMARY KEY,
          task_id           TEXT,
          effect_id         TEXT,
          operation_digest  TEXT NOT NULL,
          operation_description TEXT NOT NULL,
          effect_category   TEXT NOT NULL,
          target_node_id    TEXT,
          account           TEXT,
          decider           TEXT NOT NULL,
          decision          TEXT NOT NULL,
          requested_at      TEXT NOT NULL,
          expires_at        TEXT NOT NULL,
          decided_at        TEXT
        );
        CREATE INDEX idx_approvals_pending ON approvals(decision, expires_at);

        CREATE TABLE leases (
          lease_id          TEXT PRIMARY KEY,
          resource_node_id  TEXT NOT NULL,
          resource_id       TEXT NOT NULL,
          resource_kind     TEXT NOT NULL,
          holder_run_id     TEXT,
          holder_task_id    TEXT,
          epoch             INTEGER NOT NULL,
          acquired_at       TEXT NOT NULL,
          expires_at        TEXT NOT NULL,
          released_at       TEXT
        );
        -- A resource has at most one live lease. Partial unique index on the
        -- unreleased rows is what actually enforces one writer per resource (T14).
        CREATE UNIQUE INDEX idx_leases_live
          ON leases(resource_node_id, resource_id, resource_kind)
          WHERE released_at IS NULL;
      `);
    },
  },
  {
    version: 4,
    name: "packages-connections-widgets",
    reversible: true,
    up: (db) => {
      db.exec(`
        CREATE TABLE install_plans (
          plan_id           TEXT PRIMARY KEY,
          requirement_key   TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          target_node_id    TEXT NOT NULL,
          candidate         TEXT NOT NULL,
          plan_digest       TEXT NOT NULL,
          document          TEXT NOT NULL,
          state             TEXT NOT NULL,
          consented_digest  TEXT,
          consented_at      TEXT,
          created_at        TEXT NOT NULL,
          expires_at        TEXT NOT NULL
        );
        -- One live plan per (requirement, node): two tasks needing the same pack
        -- join one plan instead of racing to install it twice (T20).
        CREATE UNIQUE INDEX idx_install_plans_active_requirement
          ON install_plans(requirement_key, target_node_id)
          WHERE state NOT IN ('declined','failed','cancelled');

        CREATE TABLE package_generations (
          generation_id     TEXT PRIMARY KEY,
          package_id        TEXT NOT NULL,
          version           TEXT NOT NULL,
          digest            TEXT NOT NULL,
          node_id           TEXT NOT NULL,
          code_generation   TEXT NOT NULL,
          activated_at      TEXT NOT NULL,
          superseded_at     TEXT,
          document          TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_generation_active
          ON package_generations(package_id, node_id)
          WHERE superseded_at IS NULL;

        CREATE TABLE capabilities (
          capability_ref    TEXT NOT NULL,
          execution_node_id TEXT NOT NULL,
          package_generation TEXT,
          readiness         TEXT NOT NULL,
          effect_category   TEXT NOT NULL,
          summary           TEXT NOT NULL,
          document          TEXT NOT NULL,
          updated_at        TEXT NOT NULL,
          PRIMARY KEY (capability_ref, execution_node_id)
        );

        -- Connections own credentials on exactly one node. credential_node_id is
        -- part of the row so a remote task can be routed to the right place
        -- rather than the token being copied (T71).
        CREATE TABLE connections (
          connection_id     TEXT PRIMARY KEY,
          provider          TEXT NOT NULL,
          credential_node_id TEXT NOT NULL,
          account_id        TEXT,
          status            TEXT NOT NULL,
          granted_scopes    TEXT NOT NULL,
          missing_scopes    TEXT NOT NULL,
          last_probe_at     TEXT,
          last_probe_result TEXT,
          document          TEXT NOT NULL,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );
        CREATE INDEX idx_connections_provider ON connections(provider, credential_node_id);

        CREATE TABLE auth_transactions (
          transaction_id    TEXT PRIMARY KEY,
          connection_id     TEXT NOT NULL,
          flow              TEXT NOT NULL,
          state_nonce       TEXT NOT NULL,
          code_verifier     TEXT NOT NULL,
          redirect_uri      TEXT NOT NULL,
          state             TEXT NOT NULL,
          created_at        TEXT NOT NULL,
          expires_at        TEXT NOT NULL,
          completed_at      TEXT
        );

        CREATE TABLE widget_instances (
          instance_id       TEXT PRIMARY KEY,
          definition_id     TEXT NOT NULL,
          definition_version TEXT NOT NULL,
          package_digest    TEXT NOT NULL,
          owner_node_id     TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          revision          INTEGER NOT NULL,
          presentation_revision INTEGER NOT NULL,
          data_revision     INTEGER NOT NULL,
          action_binding_revision INTEGER NOT NULL,
          lifecycle         TEXT NOT NULL,
          document          TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );

        CREATE TABLE widget_snapshots (
          snapshot_id       TEXT PRIMARY KEY,
          instance_id       TEXT,
          message_id        TEXT NOT NULL,
          captured_revision INTEGER NOT NULL,
          captured_at       TEXT NOT NULL,
          stale             INTEGER NOT NULL,
          document          TEXT NOT NULL
        );
        CREATE INDEX idx_snapshots_message ON widget_snapshots(message_id);

        -- Pin points at the logical instance. Pin and inline view share it, so
        -- there is one live media owner rather than two (T47, T48).
        CREATE TABLE pins (
          pin_id            TEXT PRIMARY KEY,
          conversation_id   TEXT NOT NULL REFERENCES conversations(conversation_id),
          instance_id       TEXT NOT NULL REFERENCES widget_instances(instance_id),
          display_mode      TEXT NOT NULL,
          position          INTEGER NOT NULL,
          refresh_policy    TEXT NOT NULL,
          background_grant_id TEXT,
          created_at        TEXT NOT NULL
        );
        CREATE INDEX idx_pins_conversation ON pins(conversation_id, position);

        CREATE TABLE action_bindings (
          action_binding_id TEXT PRIMARY KEY,
          instance_id       TEXT NOT NULL REFERENCES widget_instances(instance_id),
          definition_id     TEXT NOT NULL,
          package_generation TEXT NOT NULL,
          binding_digest    TEXT NOT NULL,
          effect_category   TEXT NOT NULL,
          requires_approval INTEGER NOT NULL,
          document          TEXT NOT NULL,
          created_at        TEXT NOT NULL
        );
        CREATE INDEX idx_bindings_instance ON action_bindings(instance_id);

        -- Client-supplied invocation ids: a double click inserts once, so the
        -- second attempt sees the recorded outcome (T43).
        CREATE TABLE action_invocations (
          invocation_id     TEXT PRIMARY KEY,
          action_binding_id TEXT NOT NULL,
          instance_id       TEXT NOT NULL,
          outcome           TEXT NOT NULL,
          recorded_at       TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 5,
    name: "messages-artifacts-preferences",
    reversible: true,
    up: (db) => {
      db.exec(`
        CREATE TABLE messages (
          message_id        TEXT PRIMARY KEY,
          conversation_id   TEXT NOT NULL REFERENCES conversations(conversation_id),
          role              TEXT NOT NULL,
          author_node_id    TEXT NOT NULL,
          task_id           TEXT,
          delivery          TEXT NOT NULL,
          document          TEXT NOT NULL,
          sequence          INTEGER NOT NULL,
          created_at        TEXT NOT NULL
        );
        CREATE INDEX idx_messages_conversation ON messages(conversation_id, sequence);

        CREATE TABLE artifacts (
          artifact_id       TEXT PRIMARY KEY,
          digest            TEXT NOT NULL,
          size_bytes        INTEGER NOT NULL,
          mime_type         TEXT NOT NULL,
          classification    TEXT NOT NULL,
          origin_node_id    TEXT NOT NULL,
          blob_path         TEXT,
          created_at        TEXT NOT NULL,
          expires_at        TEXT
        );
        CREATE INDEX idx_artifacts_expiry ON artifacts(expires_at);

        CREATE TABLE datasets (
          dataset_id        TEXT PRIMARY KEY,
          origin_node_id    TEXT NOT NULL,
          row_count         INTEGER NOT NULL,
          freshness         TEXT NOT NULL,
          updated_at        TEXT NOT NULL,
          document          TEXT NOT NULL
        );

        CREATE TABLE leases_epochs (
          resource_node_id  TEXT NOT NULL,
          resource_id       TEXT NOT NULL,
          current_epoch     INTEGER NOT NULL,
          updated_at        TEXT NOT NULL,
          PRIMARY KEY (resource_node_id, resource_id)
        );

        CREATE TABLE preferences (
          principal_id      TEXT NOT NULL,
          key               TEXT NOT NULL,
          value             TEXT NOT NULL,
          scope             TEXT NOT NULL,
          source            TEXT NOT NULL,
          revision          INTEGER NOT NULL,
          previous_value    TEXT,
          created_at        TEXT NOT NULL,
          PRIMARY KEY (principal_id, key, scope)
        );

        CREATE TABLE onboarding_checkpoints (
          principal_id      TEXT NOT NULL,
          node_id           TEXT NOT NULL,
          recipe_id         TEXT NOT NULL,
          step_id           TEXT NOT NULL,
          status            TEXT NOT NULL,
          context           TEXT,
          updated_at        TEXT NOT NULL,
          PRIMARY KEY (principal_id, node_id, recipe_id, step_id)
        );

        CREATE TABLE automation_targets (
          target_id         TEXT PRIMARY KEY,
          node_id           TEXT NOT NULL,
          kind              TEXT NOT NULL,
          resource_version  TEXT NOT NULL,
          session_id        TEXT NOT NULL,
          lease_id          TEXT,
          document          TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );

        CREATE TABLE usage_counters (
          node_id           TEXT NOT NULL,
          scope_key         TEXT NOT NULL,
          window_start      TEXT NOT NULL,
          runs              INTEGER NOT NULL DEFAULT 0,
          tokens            INTEGER NOT NULL DEFAULT 0,
          artifact_bytes    INTEGER NOT NULL DEFAULT 0,
          wall_clock_ms     INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (node_id, scope_key, window_start)
        );

        CREATE TABLE emergency_stops (
          node_id           TEXT PRIMARY KEY,
          scope             TEXT NOT NULL,
          requested_at      TEXT NOT NULL,
          reason            TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 6,
    name: "voice-sessions",
    reversible: true,
    up: (db) => {
      db.exec(`
        CREATE TABLE voice_sessions (
          voice_session_id  TEXT PRIMARY KEY,
          node_id           TEXT NOT NULL,
          principal_id      TEXT NOT NULL,
          state             TEXT NOT NULL,
          provider          TEXT NOT NULL,
          media_focus       TEXT NOT NULL,
          started_at        TEXT NOT NULL,
          ended_at          TEXT,
          document          TEXT NOT NULL
        );
        CREATE INDEX idx_voice_sessions_node ON voice_sessions(node_id, started_at);
      `);
    },
  },
  {
    version: 7,
    name: "widget-live-owners",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- One live owner per widget instance. Mounting an instance inline and
        -- pinned at once must not create two live owners, because that would mean
        -- two audio elements or two call sessions for one logical widget (T47).
        CREATE TABLE widget_live_owners (
          instance_id       TEXT PRIMARY KEY REFERENCES widget_instances(instance_id),
          owner_token       TEXT NOT NULL,
          owner_surface     TEXT NOT NULL,
          claimed_at        TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 8,
    name: "widget-state",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- Per-instance widget state, which is also where an unsaved draft lives.
        --
        -- state_revision is the value the editor last read, so an autosave that
        -- was composed against older content is refused rather than overwriting
        -- newer content (T46). Keeping the draft in the same row as the committed
        -- state is what lets a refused save preserve the draft instead of losing
        -- it: a conflict clears nothing.
        CREATE TABLE widget_state (
          instance_id       TEXT PRIMARY KEY REFERENCES widget_instances(instance_id),
          state_version     INTEGER NOT NULL,
          state_revision    INTEGER NOT NULL,
          document          TEXT NOT NULL,
          draft             TEXT,
          draft_revision    INTEGER,
          draft_editor      TEXT,
          draft_saved_at    TEXT,
          updated_at        TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 9,
    name: "conditional-documents",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- A document read from somewhere else, held with the version marker the source gave
        -- us. The draft column is the same idea as widget_state's: a write composed against a
        -- version that has since moved is refused, and the caller's text is kept so the refusal
        -- is recoverable rather than destructive (T37).
        CREATE TABLE conditional_documents (
          document_id       TEXT PRIMARY KEY,
          etag              TEXT NOT NULL,
          revision          INTEGER NOT NULL,
          body              TEXT NOT NULL,
          draft             TEXT
        );
      `);
    },
  },
  {
    version: 10,
    name: "composed-surfaces-bundles-calendar",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- The compiled layout document for a composed surface. Held separately from
        -- widget_instances.props because it is a document with its own lifecycle: it is written
        -- once by the pure compiler and read back verbatim, never patched in place.
        CREATE TABLE surface_compositions (
          composition_id     TEXT PRIMARY KEY,
          instance_id        TEXT NOT NULL REFERENCES widget_instances(instance_id),
          owner_principal_id TEXT NOT NULL,
          message_id         TEXT NOT NULL,
          conversation_id    TEXT NOT NULL,
          template_id        TEXT NOT NULL,
          template_version   TEXT NOT NULL,
          catalog_digest     TEXT NOT NULL,
          section_count      INTEGER NOT NULL,
          document           TEXT NOT NULL,
          created_at         TEXT NOT NULL
        );
        CREATE INDEX idx_compositions_instance ON surface_compositions(instance_id);
        CREATE INDEX idx_compositions_owner ON surface_compositions(owner_principal_id, created_at);

        -- The materialised snapshot. Immutable: nothing updates the document column, and the
        -- only mutation the schema permits is recording that the data was deleted, which turns
        -- the bundle into a tombstone instead of quietly resurrecting deleted values through
        -- the live source.
        CREATE TABLE presentation_bundles (
          bundle_id          TEXT PRIMARY KEY,
          snapshot_id        TEXT NOT NULL REFERENCES widget_snapshots(snapshot_id),
          message_id         TEXT NOT NULL,
          instance_id        TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          byte_size          INTEGER NOT NULL,
          deleted_at         TEXT,
          tombstone_reason   TEXT,
          document           TEXT NOT NULL,
          created_at         TEXT NOT NULL
        );
        CREATE INDEX idx_bundles_snapshot ON presentation_bundles(snapshot_id);
        CREATE INDEX idx_bundles_message ON presentation_bundles(message_id);
        CREATE INDEX idx_bundles_owner ON presentation_bundles(owner_principal_id, created_at);

        -- Local calendar events. User-entered only: nothing here is synced from a provider, and
        -- there is no producer column that would let a task invent a due date and have it look
        -- like something the user wrote.
        CREATE TABLE calendar_events (
          event_id           TEXT PRIMARY KEY,
          owner_principal_id TEXT NOT NULL,
          node_id            TEXT NOT NULL,
          title              TEXT NOT NULL,
          starts_at          TEXT NOT NULL,
          ends_at            TEXT NOT NULL,
          timezone           TEXT NOT NULL,
          local_date         TEXT NOT NULL,
          document           TEXT NOT NULL,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL,
          deleted_at         TEXT
        );
        CREATE INDEX idx_calendar_owner_range
          ON calendar_events(owner_principal_id, starts_at) WHERE deleted_at IS NULL;

        -- Imported images. The bytes live in the blob store; this row is the authorization and
        -- validation record, which is why the principal is on it rather than inferred from the
        -- artifact id.
        CREATE TABLE local_images (
          image_id           TEXT PRIMARY KEY,
          owner_principal_id TEXT NOT NULL,
          node_id            TEXT NOT NULL,
          artifact_id        TEXT NOT NULL,
          mime_type          TEXT NOT NULL,
          byte_size          INTEGER NOT NULL,
          width              INTEGER,
          height             INTEGER,
          digest             TEXT NOT NULL,
          alt_text           TEXT NOT NULL,
          blob_path          TEXT NOT NULL,
          created_at         TEXT NOT NULL,
          deleted_at         TEXT
        );
        CREATE INDEX idx_images_owner ON local_images(owner_principal_id, created_at);

        -- A live-owner claim without an expiry is an orphan waiting to happen: a tab that is
        -- killed never sends its release, and the instance would then be locked forever. The
        -- column is nullable so rows written before it exist stay readable, and a claim with no
        -- expiry is treated as stale once it is older than the lease window.
        ALTER TABLE widget_live_owners ADD COLUMN lease_expires_at TEXT;
      `);
    },
  },
  {
    version: 11,
    name: "dataset-principal-scope",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- Datasets the node registered for itself (the sample) are node-scoped and leave this NULL.
        -- A dataset derived for one person's composed surface names them, so a reference that leaks
        -- into another principal's page resolves to nothing rather than to someone else's rows.
        ALTER TABLE datasets ADD COLUMN owner_principal_id TEXT;
        CREATE INDEX idx_datasets_owner ON datasets(owner_principal_id, updated_at);
      `);
    },
  },
  {
    version: 12,
    name: "session-files",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- The worker's own JSONL transcript, indexed so it can be read back after a restart and
        -- ingested into the history index in bounded batches.
        --
        -- Two sources of history are deliberate: the messages table is what the conversation
        -- showed, and this is what the worker actually did — tool calls, reasoning, summaries.
        -- Neither is derived from the other, and there is no synchronisation between them.
        CREATE TABLE session_files (
          session_id        TEXT PRIMARY KEY,
          node_id           TEXT NOT NULL,
          principal_id      TEXT NOT NULL,
          task_id           TEXT,
          conversation_id   TEXT,
          path              TEXT NOT NULL,
          byte_size         INTEGER NOT NULL DEFAULT 0,
          -- Byte offset already ingested, so a restart resumes rather than reindexing the file.
          ingest_cursor     INTEGER NOT NULL DEFAULT 0,
          last_ingested_at  TEXT,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );
        CREATE INDEX idx_session_files_principal ON session_files(principal_id, created_at);
        CREATE INDEX idx_session_files_task ON session_files(task_id);
      `);
    },
  },
  {
    version: 13,
    name: "history-fts",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- Lexical retrieval over everything the node can search: what the conversation showed, and
        -- what a worker actually did.
        --
        -- One table with a source column rather than two indexes, because the two are ranked
        -- against each other and merged; keeping them apart would mean merging after ranking, which
        -- is not the same result.
        --
        -- remove_diacritics 2 is what makes Vietnamese searchable at all: a query typed without
        -- tone marks matches text written with them, in both directions.
        CREATE VIRTUAL TABLE history_fts USING fts5(
          text,
          source UNINDEXED,
          ref UNINDEXED,
          conversation_id UNINDEXED,
          task_id UNINDEXED,
          principal_id UNINDEXED,
          created_at UNINDEXED,
          tokenize = 'unicode61 remove_diacritics 2'
        );

        -- Deletion is a trigger because a deleted message must not stay searchable, and the write
        -- path that removes a message is not the one that indexes it. Insertion is explicit: the
        -- text is extracted from a JSON document in TypeScript, where it is testable.
        CREATE TRIGGER messages_history_delete AFTER DELETE ON messages BEGIN
          DELETE FROM history_fts WHERE source = 'message' AND ref = OLD.message_id;
        END;
      `);
    },
  },
  {
    version: 14,
    name: "project-index",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- What is on this machine and where, so "add a skill for the agentkit project" can find the
        -- directory without the user typing a path.
        --
        -- Metadata only: the scan records markers, a name and a modification time. Nothing here is
        -- file content, which is what makes an index over a home directory defensible.
        CREATE TABLE project_index (
          project_id    TEXT PRIMARY KEY,
          node_id       TEXT NOT NULL,
          path          TEXT NOT NULL,
          name          TEXT NOT NULL,
          -- Names the user or an agent has used for it. A JSON array of strings.
          aliases       TEXT NOT NULL DEFAULT '[]',
          git_remote    TEXT,
          -- Markers that made this a project, as a JSON array: .git, package.json, .obsidian, …
          markers       TEXT NOT NULL DEFAULT '[]',
          kind          TEXT NOT NULL,
          -- Directory mtime, which is what incremental refresh compares.
          mtime         INTEGER NOT NULL,
          last_used_at  TEXT,
          indexed_at    TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_project_path ON project_index(node_id, path);
        CREATE INDEX idx_project_kind ON project_index(node_id, kind);
        CREATE INDEX idx_project_used ON project_index(last_used_at);

        -- Matching by name is a search, not a scan: a home directory holds hundreds of
        -- directories, and a substring scan on every keystroke is the wrong shape for it.
        CREATE VIRTUAL TABLE project_fts USING fts5(
          name,
          aliases,
          path,
          kind UNINDEXED,
          project_id UNINDEXED,
          tokenize = 'unicode61 remove_diacritics 2'
        );
      `);
    },
  },
  {
    version: 15,
    name: "history-embeddings",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- Which history rows have a vector, and which model produced it.
        --
        -- Separate from the vector table itself because the vector table cannot exist without a
        -- loadable extension, and a migration runs whether or not sqlite-vec is installed on this
        -- machine. This half is plain SQL: it always applies, so an upgrade never depends on an
        -- optional dependency being present.
        CREATE TABLE history_embeddings_meta (
          source        TEXT NOT NULL,
          ref           TEXT NOT NULL,
          principal_id  TEXT NOT NULL,
          model         TEXT NOT NULL,
          dims          INTEGER NOT NULL,
          -- Digest of the model artifact, so a silent model swap is detectable.
          digest        TEXT NOT NULL,
          -- The rowid in the vec0 table. Recorded here because vec0 assigns it, and a mapping kept
          -- only inside the extension is a mapping that cannot be rebuilt or audited.
          vec_rowid     INTEGER NOT NULL,
          created_at    TEXT NOT NULL,
          PRIMARY KEY (source, ref)
        );
        CREATE INDEX idx_embedding_model ON history_embeddings_meta(model, dims);
        CREATE INDEX idx_embedding_vec ON history_embeddings_meta(vec_rowid);
      `);
    },
  },
  {
    version: 16,
    name: "credentials",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- Secrets a person typed into the host, by name.
        --
        -- Named after what a credential is *for* rather than after a provider, because one provider can need
        -- two: a key for the assistant and a key for voice. The value is stored as given and is read only by
        -- the host when it calls that provider; no route returns it, no listing includes it, and no log line
        -- carries it.
        --
        -- At-rest encryption is not claimed here. The database sits in the node's own data directory, and
        -- encrypting with a key stored beside the ciphertext would be a promise this code cannot keep.
        CREATE TABLE credentials (
          principal_id  TEXT NOT NULL,
          name          TEXT NOT NULL,
          value         TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          PRIMARY KEY (principal_id, name)
        );
      `);
    },
  },
  {
    version: 17,
    name: "attachments",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- Files a person attached to a message.
        --
        -- The bytes live in the node's blob directory under a content-addressed name; this table is the
        -- record of which principal attached which file to which conversation, and it is what the quota
        -- is summed from. A row is a reference, never an authority: reading the bytes checks containment
        -- against the blob root first.
        --
        -- No ON DELETE CASCADE, deliberately. conversations has no cascade either and foreign_keys is ON,
        -- so deleting a conversation is a change that needs its own policy (what happens to a running
        -- task?) rather than something an attachments migration decides quietly. Removal is explicit,
        -- through releaseConversationAttachments.
        CREATE TABLE attachments (
          attachment_id   TEXT PRIMARY KEY,
          principal_id    TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          filename        TEXT NOT NULL,
          mime            TEXT NOT NULL,
          kind            TEXT NOT NULL,
          size_bytes      INTEGER NOT NULL,
          sha256          TEXT NOT NULL,
          blob_path       TEXT NOT NULL,
          created_at      TEXT NOT NULL
        );
        CREATE INDEX attachments_conversation ON attachments(conversation_id);
        CREATE INDEX attachments_principal ON attachments(principal_id);
      `);
    },
  },
  {
    version: 18,
    name: "memory-records",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- One thing the node remembered, and the conversation it was learned in.
        --
        -- Deleted for real rather than flagged: the Memory tab removes a row, and a soft-delete column
        -- would make every read remember to filter it out - which is one forgotten filter away from
        -- showing somebody something they had removed.
        --
        -- A row is a sentence the agent chose to keep, not a copy of the conversation, and the
        -- conversation it came from is kept by id so a person reading the list can tell what it was for.
        CREATE TABLE memory_records (
          memory_id TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          source_message_id TEXT,
          kind TEXT NOT NULL,
          scope TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX memory_records_principal ON memory_records(principal_id, created_at DESC);
      `);
    },
  },
  {
    version: 19,
    name: "secrets",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- What a secret is for, who may use it, and where the value actually lives.
        --
        -- Metadata only. The value stays in a backend — the node's own store today, a keychain or an external
        -- vault later — and this table is what lets the agent and the interface talk about a secret without ever
        -- holding one. That split is the whole point: the model may learn that "github_token" exists, what it is
        -- for, and which consumers are allowed to use it, and still has no way to read it.
        --
        -- backend_ref is opaque to callers: the node-store backend reads it as a credential name, a keychain
        -- backend would read it as a service path. Keeping it opaque here is what lets the backend change without
        -- a migration that rewrites rows.
        --
        -- allowed_consumers and injection_policy are JSON and text rather than joined tables because they are
        -- read whole, written whole, and small: a secret's consumer list is not something to query across.
        CREATE TABLE secrets (
          secret_id         TEXT PRIMARY KEY,
          principal_id      TEXT NOT NULL,
          node_id           TEXT,
          name              TEXT NOT NULL,
          description       TEXT NOT NULL DEFAULT '',
          kind              TEXT NOT NULL DEFAULT 'api-key',
          backend           TEXT NOT NULL DEFAULT 'node-store',
          backend_ref       TEXT NOT NULL,
          allowed_consumers TEXT NOT NULL DEFAULT '[]',
          injection_policy  TEXT NOT NULL DEFAULT 'tool-only',
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL,
          last_used_at      TEXT,
          UNIQUE (principal_id, name)
        );
        CREATE INDEX idx_secrets_principal ON secrets(principal_id);
      `);
    },
  },
  {
    version: 20,
    name: "audit_log",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- What this node did, in order, in words.
        --
        -- Append-only by convention rather than by trigger: nothing in the codebase updates or deletes a row here,
        -- and the reason to keep it is the question asked after something surprising happened. A row says what was
        -- done and how it ended; it never holds a secret value, an argument dump or a transcript, because an audit
        -- trail that leaked is worse than the failure it was kept for.
        --
        -- Separate from the effect ledger, which tracks how far an external effect got. This is the human-readable
        -- record of what a person or an agent asked this node to do and what came of it.
        CREATE TABLE audit_log (
          audit_id     TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL,
          node_id      TEXT,
          at           TEXT NOT NULL,
          kind         TEXT NOT NULL,
          summary      TEXT NOT NULL,
          outcome      TEXT NOT NULL,
          ref          TEXT
        );
        CREATE INDEX idx_audit_principal_at ON audit_log(principal_id, at);
      `);
    },
  },
  {
    // 21, not 19: main added this migration at the version this branch already uses for `secrets`, and the two are
    // kept — a schema version is the count of migrations, so the next free number is the honest one.
    version: 21,
    name: "peers-and-pairing",
    reversible: true,
    up: (db) => {
      db.exec(`
        -- A single-use introduction between two nodes.
        --
        -- The invite is an introduction, not a credential: claiming it establishes only that two
        -- nodes know each other's identity. Nothing becomes reachable and no grant is created until
        -- a person confirms the pairing, which is a separate act on each side.
        --
        -- A claimed invite is kept rather than deleted, because "this invite was already used" and
        -- "this invite never existed" are different answers to a replay, and collapsing them would
        -- hide a stolen invite behind an ordinary 404.
        CREATE TABLE pair_invites (
          invite_id       TEXT PRIMARY KEY,
          issuer_node_id  TEXT NOT NULL,
          endpoint        TEXT NOT NULL,
          fingerprint     TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          expires_at      TEXT NOT NULL,
          claimed_at      TEXT,
          claimed_by      TEXT
        );

        -- A node this one knows.
        --
        -- Recorded when a claim arrives, trusted only after a person confirms it: trusted_at null
        -- means the pairing is pending, and a pending peer is refused an envelope rather than having
        -- one queued for later.
        --
        -- token_hash is the sha256 of the token the peer presents to this node, so the credential
        -- itself is never stored and a copy of this database cannot be replayed at the peer.
        CREATE TABLE peers (
          peer_node_id    TEXT PRIMARY KEY,
          endpoint        TEXT NOT NULL,
          public_key      TEXT NOT NULL,
          fingerprint     TEXT NOT NULL,
          token_hash      TEXT NOT NULL,
          paired_at       TEXT NOT NULL,
          trusted_at      TEXT,
          revoked_at      TEXT
        );

        -- Inbound peer requests are authenticated by looking the presented token's hash up here, so
        -- the lookup has to be direct. Unique as well: two peers sharing a token would make the hash
        -- ambiguous about which node a request came from, and that identity is what every envelope is
        -- validated against.
        CREATE UNIQUE INDEX idx_peers_token_hash ON peers(token_hash);
      `);
    },
  },
  {
    version: 22,
    name: "backfill_generation_granted_capabilities",
    reversible: false,
    up: (db) => {
      /*
       * Before `grantedCapabilities` existed on `package_generations`, an install granted whatever the package's
       * manifest requested outright — there was no narrower "derived from policy" set at all, and a frame was
       * brokered the full `requestedCapabilities` unconditionally. A generation activated under that old code has
       * no `grantedCapabilities` key in its stored `document` JSON at all, and reading it back now (the schema
       * requires the field) would silently produce `undefined` at runtime — which then brokers *nothing* to a
       * widget that was, under the semantics it was actually installed with, entitled to what it asked for.
       *
       * The decision here (recorded by the controller reviewing this fix, not invented by this migration) is to
       * backfill each such row as if it had gone through the plan it actually did: the `install_plans` row this
       * generation's own package+version last resolved through, read for the `requestedCapabilityRefs` its
       * document carried, which is the closest honest answer to "what this generation was actually consented for"
       * under the old semantics — not a fresh policy re-decision, which would use today's policy against
       * yesterday's install and could grant or deny something the original consent never considered. A generation
       * with no matching plan row (already superseded and pruned, or never had one) is backfilled to `[]` rather
       * than guessed at: an empty grant under-serves rather than over-grants, which is the direction a backward-
       * compatibility gap should err.
       */
      const generations = readAll<{ generation_id: string; package_id: string; version: string; document: string }>(
        db,
        "SELECT generation_id, package_id, version, document FROM package_generations",
      );

      for (const row of generations) {
        let parsedDocument: Record<string, unknown>;
        try {
          parsedDocument = JSON.parse(row.document) as Record<string, unknown>;
        } catch {
          // A document that does not even parse as JSON is a corruption this migration is not the place to fix;
          // leave it untouched rather than overwrite it with a guess.
          continue;
        }
        if (Array.isArray(parsedDocument["grantedCapabilities"])) continue;

        const requirementKey = `pkg:${row.package_id}@${row.version}`;
        const plan = db
          .prepare(`SELECT document FROM install_plans WHERE requirement_key = ? ORDER BY created_at DESC LIMIT 1`)
          .get(requirementKey) as { document: string } | undefined;

        let backfilled: unknown[] = [];
        if (plan !== undefined) {
          try {
            const planDocument = JSON.parse(plan.document) as { requestedCapabilityRefs?: unknown };
            if (Array.isArray(planDocument.requestedCapabilityRefs)) {
              backfilled = planDocument.requestedCapabilityRefs;
            }
          } catch {
            // Same reasoning as above: an unparseable plan document backfills to `[]` rather than guessing.
          }
        }

        parsedDocument["grantedCapabilities"] = backfilled;
        db.prepare("UPDATE package_generations SET document = ? WHERE generation_id = ?").run(
          JSON.stringify(parsedDocument),
          row.generation_id,
        );
      }
    },
  },
];

function readAll<T>(db: Database, sql: string): T[] {
  return db.prepare(sql).all() as T[];
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: number[];
}

export function currentSchemaVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** Validate the migration list before touching a database. */
export function assertMigrationListIsSane(
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const seen = new Set<number>();
  let previous = 0;
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new Error(`duplicate migration version ${migration.version}`);
    }
    if (migration.version <= previous) {
      throw new Error(
        `migration ${migration.version} (${migration.name}) is out of order; expected a version greater than ${previous}`,
      );
    }
    seen.add(migration.version);
    previous = migration.version;
  }
}

/**
 * Apply every pending migration.
 *
 * Each migration runs in its own transaction so that a failure leaves the
 * database at the last fully-applied version. A partially applied migration is
 * worse than a stopped upgrade, because the next boot would then reason from a
 * version number that does not describe the actual schema.
 */
export function migrate(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  assertMigrationListIsSane(migrations);
  const from = currentSchemaVersion(db);
  const applied: number[] = [];

  for (const migration of migrations) {
    if (migration.version <= from) continue;
    transaction(db, () => {
      migration.up(db);
      // user_version does not accept a bound parameter, and the value is a
      // validated integer from our own migration list.
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
    applied.push(migration.version);
  }

  return { from, to: currentSchemaVersion(db), applied };
}

/**
 * Report migrations that cannot be rolled back.
 *
 * An upgrade plan needs to know which steps a binary downgrade would not undo, so
 * the answer is computed rather than left to whoever reads the release notes.
 */
export function irreversibleUpgradeSteps(
  from: number,
  migrations: readonly Migration[] = MIGRATIONS,
): Migration[] {
  return migrations.filter((migration) => migration.version > from && !migration.reversible);
}
