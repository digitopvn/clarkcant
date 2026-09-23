import {
  RealPiAdapter,
  canonicalRoots,
  createScopedFsTools,
  type ModelSelection,
  type PiAdapter,
  type WorkerBrief,
} from "@clarkcant/pi-adapter";

/**
 * Starting a worker session in a directory the finder chose.
 *
 * The finder answers *where*; this answers *how a session starts there*. It exists as its own module
 * because the two failure modes are different: a finder that cannot find a directory asks the user a
 * question, while a session that cannot start reports why the node cannot run one.
 *
 * The brief is the part worth reading. `projectRoots` is the enforced filesystem boundary of the session:
 * every approved root is canonicalised here, the scoped read tools are built from them, and the brief tells
 * the adapter to leave the SDK's own file tools out of the allowlist. A session started in a directory is a
 * session that may read that directory and nowhere else — a starter that dropped a root would turn "work in
 * this project" into "work anywhere".
 */

export interface ProjectSessionStarter {
  /** Whether a session could be started at all, with the reason when it could not. */
  available: () => { available: boolean; reason?: string };
  /** Start one session. The caller has already verified the directory. */
  start: (input: {
    /** The user's own words, plus a short note about which project was chosen. */
    goal: string;
    /** The approved directories. Every one of them becomes the session's enforced boundary. */
    projectRoots: readonly string[];
  }) => Promise<{ sessionId: string; sessionFile: string | undefined }>;
}

export interface ProjectSessionOptions {
  /** Where transcripts are written. */
  sessionDir: string;
  /** The model this node is configured for, when it has one. */
  model?: ModelSelection;
  agentDir?: string;
  /**
   * Builds the adapter for the session's working directory.
   *
   * Injected so a test can substitute a fake and assert the brief, rather than loading the SDK and
   * spawning a real session for a journey test. The working directory is the first approved root; the
   * boundary is the brief, so an injected adapter is handed the same roots as a real one.
   */
  createAdapter?: (cwd: string) => PiAdapter;
  /** Called once a transcript exists, so the runtime can index it. */
  onSessionFile?: (input: { sessionId: string; sessionFile: string }) => void;
}

export function createProjectSessionStarter(options: ProjectSessionOptions): ProjectSessionStarter {
  return {
    available: () => ({ available: true }),
    async start(input): Promise<{ sessionId: string; sessionFile: string | undefined }> {
      /*
       * The boundary is built before the session exists.
       *
       * `canonicalRoots` resolves each approved root with `fs.realpath`, so the paths the tools compare against
       * are the directories themselves rather than names that could point elsewhere. Every root is checked, not
       * just the first: a second root used to be dropped without a word, and a session confined to something
       * other than what was approved is a boundary nobody can reason about. A refused root stops the session by
       * name for the same reason.
       */
      const approved = await canonicalRoots(input.projectRoots);
      if (approved.refused.length > 0) {
        throw new Error(
          `a project session cannot start in ${approved.refused
            .map((entry) => `${entry.root} (${entry.reason})`)
            .join("; ")}`,
        );
      }
      const roots = [...approved.roots];
      const cwd = roots[0];
      if (cwd === undefined) {
        throw new Error("a project session needs a directory to run in");
      }

      const adapter =
        options.createAdapter?.(cwd) ??
        new RealPiAdapter({
          // The SDK requires a working directory, and the first approved root is the only defensible choice for it.
          // It is deliberately not the boundary: `cwd` is a process convenience that a tool can ignore, so the
          // boundary travels on the brief as `projectRoots` and the tools resolve every path against it.
          cwd,
          sessionDir: options.sessionDir,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
          ...(options.onSessionFile === undefined ? {} : { onSessionFile: options.onSessionFile }),
        });

      const brief: WorkerBrief = {
        goal: input.goal,
        // Canonical, and all of them. These are the directories the session's file tools admit and nothing else.
        projectRoots: roots,
        // No capabilities are granted by starting a session: a capability is granted by the task that
        // needs it, after its own authorization. Starting a session is not a way to acquire one.
        allowedCapabilityRefs: [],
        // What makes it a boundary rather than a note: the adapter runs this session with the SDK's own
        // read/grep/find/ls absent from its allowlist, and these four tools are the whole filesystem surface left.
        confineToProjectRoots: true,
        // Built from the approval record rather than from the paths, so each tool re-checks the identity the
        // kernel gave the directory here rather than a name that something else could answer to later.
        customTools: createScopedFsTools({ roots: approved.approved }),
      };

      const handle = await adapter.createWorkerSession(brief);
      return { sessionId: handle.sessionId, sessionFile: handle.sessionFile };
    },
  };
}

/** The sentence a session is started with: the user's words, then what was chosen. */
export function initialPrompt(userText: string, projectName: string, context: string): string {
  return `${userText}\n\n${context}\n(dự án: ${projectName})`;
}
