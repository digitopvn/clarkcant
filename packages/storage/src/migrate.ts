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
];

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
