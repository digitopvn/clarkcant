import { ARTIFACT_LIMITS, JOB_LIMITS, type JobRecord } from "@clarkcant/contracts";
import type { McpToolFile } from "@clarkcant/mcp-adapters";

import {
  type ArtifactBrokerDeps,
  appendArtifactChunk,
  createWorkingArtifact,
  discardArtifact,
  finalizeArtifact,
} from "./artifact-broker.ts";

/** Service bytes use the same type, quota, grants and blob lifecycle as files created by the widget. */
export function storeJobResultArtifacts(
  broker: ArtifactBrokerDeps,
  job: Pick<JobRecord, "ownerPrincipalId" | "conversationId" | "instanceId">,
  files: readonly McpToolFile[],
  /** The granted profile's ceiling. A profile may lower the attachable maximum, never raise it. */
  maxBytes: number = ARTIFACT_LIMITS.maxBytes,
): { refs: JobRecord["resultRefs"]; omitted: boolean } {
  const ceiling = Math.min(maxBytes, ARTIFACT_LIMITS.maxBytes);
  const refs: JobRecord["resultRefs"] = [];
  if (job.conversationId === undefined) return { refs, omitted: files.length > 0 };
  const scope = { principalId: job.ownerPrincipalId, instanceId: job.instanceId };
  let omitted = files.length > JOB_LIMITS.resultRefs;
  for (const file of files.slice(0, JOB_LIMITS.resultRefs)) {
    if (file.bytes.byteLength > ceiling) {
      omitted = true;
      continue;
    }
    const created = createWorkingArtifact(broker, {
      ...scope,
      conversationId: job.conversationId,
      mimeType: file.mimeType,
    });
    if (!created.ok) {
      omitted = true;
      continue;
    }
    const target = { ...scope, artifactId: created.ref.artifactId };
    let retained = false;
    try {
      let offset = 0;
      while (offset < file.bytes.byteLength) {
        const bytes = file.bytes.subarray(offset, offset + ARTIFACT_LIMITS.chunkBytes);
        const appended = appendArtifactChunk(broker, { ...target, offset, bytes });
        if (!appended.ok) break;
        offset += bytes.byteLength;
      }
      if (offset === file.bytes.byteLength) {
        const finalized = finalizeArtifact(broker, target);
        if (finalized.ok) {
          refs.push(finalized.ref);
          retained = true;
        }
      }
    } finally {
      if (!retained) {
        discardArtifact(broker, target);
        omitted = true;
      }
    }
  }
  return { refs, omitted };
}
