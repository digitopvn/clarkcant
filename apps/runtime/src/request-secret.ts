import type { Instant } from "@clarkcant/contracts";
import type { ToolDefinition } from "@clarkcant/pi-adapter";
import {
  type Database,
  type SecretKind,
  getSecretMetadata,
  secretBackendFor,
  summarizeSecret,
} from "@clarkcant/storage";

/**
 * Asking the host for a secret, without ever holding one.
 *
 * This is the only sanctioned way an agent asks for a key, and it exists because the obvious way is wrong:
 * `ask_user_question` puts its answer into the conversation, and the conversation goes to the provider — so a key
 * typed there would be a key sent to a model. Here the value goes into the node's backend through a host-owned
 * form, and what comes back to the model is a name and a description.
 *
 * What the model learns is deliberately shaped. When the secret exists it gets `available` plus the metadata:
 * what it is for, which consumers may use it, and the injection policy. That is enough to pass `secretRef` to the
 * tool or command that needs it and not enough to leak it — there is no field in the answer that could carry a
 * value, which is a stronger statement than promising not to include one.
 */

/** How long a form stays open. The same quarter of an hour the approval card uses. */
export const SECRET_REQUEST_TTL_MS = 15 * 60_000;

export interface RequestSecretDeps {
  db: Database;
  principalId: string;
  newId: (prefix: string) => string;
  now: () => Instant;
  /** The node's own id, recorded on the card as the scope so a person knows which machine is asking. */
  nodeId?: string;
}

const KINDS: SecretKind[] = ["api-key", "token", "password", "webhook-secret", "other"];

export function createRequestSecretTool(deps: RequestSecretDeps): ToolDefinition {
  return {
    name: "request_secret",
    label: "Xin một secret từ host",
    description:
      "Ask the node for a secret by name — an API key, a token, a password. If the node already has it you are told " +
      "it is available, along with what it is for; if it does not, the user is shown a form. The value is never " +
      "returned to you and never enters this conversation, so do not try to read it: pass the name to whatever " +
      "needs it. Use this instead of ask_user_question whenever what you need is a secret, and never ask for one " +
      "in a normal question.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "label", "description"],
      properties: {
        name: {
          type: "string",
          description: "The stable name the node stores it under, e.g. github_token. Lowercase, underscores.",
        },
        label: { type: "string", description: "What the person sees on the form, e.g. “GitHub token”." },
        description: { type: "string", description: "One or two sentences: what it is for and why now." },
        secretKind: {
          type: "string",
          enum: KINDS,
          description: "What kind of secret it is. Defaults to api-key.",
        },
        consumer: {
          type: "string",
          description: "Who will use it, e.g. command:git or capability:github. Recorded as the allowed consumer.",
        },
      },
    },
    promptSnippet: "request_secret — ask the host for a secret; the value is never returned to you",
    execute: async (params: Record<string, unknown>): Promise<{ text: string; hostCard?: Record<string, unknown> }> => {
      const name = typeof params.name === "string" ? params.name.trim() : "";
      if (name === "") return { text: "Cần một tên cho secret, ví dụ github_token." };
      const label = typeof params.label === "string" && params.label.trim() !== "" ? params.label.trim() : name;
      const description = typeof params.description === "string" ? params.description.trim() : "";
      const requestedKind = typeof params.secretKind === "string" ? params.secretKind : "";
      const kind: SecretKind = KINDS.includes(requestedKind as SecretKind) ? (requestedKind as SecretKind) : "api-key";
      const consumer = typeof params.consumer === "string" ? params.consumer.trim() : "";

      const metadata = getSecretMetadata(deps.db, deps.principalId, name);
      const backend = metadata === undefined ? undefined : secretBackendFor(deps.db, deps.principalId, metadata.backend);
      // Both halves have to be true. A metadata row whose value is gone is a secret that is not available, and
      // answering "available" for it would send a caller off to use something that does not exist.
      if (metadata !== undefined && backend?.has(metadata.backendRef) === true) {
        const summary = summarizeSecret(metadata);
        return {
          text: [
            `${summary.name}: available.`,
            summary.description === "" ? "" : `Description: ${summary.description}`,
            `Allowed consumers: ${summary.allowedConsumers.length === 0 ? "(none listed)" : summary.allowedConsumers.join(", ")}`,
            `Injection policy: ${summary.injectionPolicy}`,
            // Said plainly, because the useful next step is the name and the tempting one is the value.
            `Bạn không cần giá trị: truyền secretRef "${summary.name}" cho tool hoặc lệnh cần dùng nó.`,
          ]
            .filter((line) => line !== "")
            .join("\n"),
        };
      }

      const at = deps.now();
      return {
        text:
          `Chưa có secret “${name}” trên node này. Form nhập đã được mở cho người dùng, và giá trị họ nhập sẽ không ` +
          `đi vào hội thoại. Lượt này kết thúc ở đây — lượt sau hãy gọi lại request_secret để biết đã có hay chưa.`,
        hostCard: {
          type: "credential-card",
          owner: "host",
          requestId: deps.newId("cred"),
          purpose: description === "" ? `Node này cần ${label}.` : description,
          destination: "vault-node",
          fields: [{ name, label, masked: true, hostOwned: true }],
          ...(description === "" ? {} : { description }),
          ...(consumer === "" ? {} : { consumer }),
          secretKind: kind,
          scope: deps.nodeId === undefined ? "node" : `node:${deps.nodeId}`,
          expiresAt: new Date(Date.parse(at) + SECRET_REQUEST_TTL_MS).toISOString() as Instant,
        },
      };
    },
  };
}
