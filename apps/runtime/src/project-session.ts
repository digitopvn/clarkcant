import { RealPiAdapter, type ModelSelection, type PiAdapter, type WorkerBrief } from "@clarkcant/pi-adapter";

/**
 * Starting a worker session in a directory the finder chose.
 *
 * The finder answers *where*; this answers *how a session starts there*. It exists as its own module
 * because the two failure modes are different: a finder that cannot find a directory asks the user a
 * question, while a session that cannot start reports why the node cannot run one.
 *
 * The brief is the part worth reading. `projectRoots` is the whole point — a session started in a
 * directory is a session whose tools may touch it — so a starter that silently dropped it would turn
 * "work in this project" into "work anywhere".
 */

export interface ProjectSessionStarter {
  /** Whether a session could be started at all, with the reason when it could not. */
  available: () => { available: boolean; reason?: string };
  /** Start one session. The caller has already verified the directory. */
  start: (input: {
    /** The user's own words, plus a short note about which project was chosen. */
    goal: string;
    /** The approved directory. Passed through to the brief unchanged. */
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
   * Builds the adapter for one project directory.
   *
   * Injected so a test can substitute a fake and assert the brief, rather than loading the SDK and
   * spawning a real session for a journey test.
   */
  createAdapter?: (cwd: string) => PiAdapter;
  /** Called once a transcript exists, so the runtime can index it. */
  onSessionFile?: (input: { sessionId: string; sessionFile: string }) => void;
}

export function createProjectSessionStarter(options: ProjectSessionOptions): ProjectSessionStarter {
  return {
    available: () => ({ available: true }),
    async start(input): Promise<{ sessionId: string; sessionFile: string | undefined }> {
      const root = input.projectRoots[0];
      if (root === undefined) {
        throw new Error("a project session needs a directory to run in");
      }

      const adapter =
        options.createAdapter?.(root) ??
        new RealPiAdapter({
          // The session's working directory *is* the project: that is what makes its tools reach the
          // right files, and it is why the brief carries the same path.
          cwd: root,
          sessionDir: options.sessionDir,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
          ...(options.onSessionFile === undefined ? {} : { onSessionFile: options.onSessionFile }),
        });

      const brief: WorkerBrief = {
        goal: input.goal,
        projectRoots: [...input.projectRoots],
        // No capabilities are granted by starting a session: a capability is granted by the task that
        // needs it, after its own authorization. Starting a session is not a way to acquire one.
        allowedCapabilityRefs: [],
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
