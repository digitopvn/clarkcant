import { jobIdSchema } from "@clarkcant/contracts";
import { getActionBinding, getInstance } from "@clarkcant/core";
import { instanceIsInConversation } from "@clarkcant/storage";

import type { NodeServices } from "../services.ts";
import { type GatewayRequest, type GatewayResponse, fail, json } from "./http.ts";

export interface JobRouteDeps {
  services: Pick<NodeServices, "runtime" | "conductor" | "packageJobs">;
  request: GatewayRequest;
  segments: string[];
}

function snapshot(job: NonNullable<ReturnType<NonNullable<NodeServices["packageJobs"]>["get"]>>): Record<string, unknown> {
  return {
    jobId: job.jobId,
    status: job.status,
    ...(job.progress === undefined ? {} : { progress: job.progress }),
    resultRefs: job.resultRefs,
    ...(job.output === undefined ? {} : { output: job.output }),
    ...(job.error === undefined ? {} : { error: job.error }),
    createdAt: job.createdAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
  };
}

export function handleJobRoutes(deps: JobRouteDeps): GatewayResponse | undefined {
  const { segments, request, services } = deps;
  if (segments.length !== 6 || segments[0] !== "conversations" || segments[2] !== "widgets" || segments[4] !== "jobs") {
    return undefined;
  }
  if (request.method !== "GET" && request.method !== "POST") return undefined;
  if (services.packageJobs === undefined) return fail(503, "JOB_UNAVAILABLE", "package jobs are unavailable on this node");

  const conversationId = decodeURIComponent(segments[1] ?? "");
  const instanceId = decodeURIComponent(segments[3] ?? "");
  const parsedId = jobIdSchema.safeParse(decodeURIComponent(segments[5] ?? ""));
  if (!parsedId.success || conversationId === "" || instanceId === "") {
    return fail(404, "JOB_NOT_FOUND", "that job is not available to this widget");
  }
  if (!instanceIsInConversation(services.runtime.db, { conversationId, instanceId })) {
    return fail(404, "JOB_NOT_FOUND", "that job is not available to this widget");
  }
  const instance = getInstance(services.conductor, instanceId);
  if (instance === undefined || instance.ownerPrincipalId !== services.runtime.identity.ownerPrincipalId) {
    return fail(404, "JOB_NOT_FOUND", "that job is not available to this widget");
  }

  let owned = undefined as ReturnType<NonNullable<NodeServices["packageJobs"]>["get"]>;
  for (const actionBindingId of instance.actionBindingIds) {
    const binding = getActionBinding(services.conductor, actionBindingId);
    if (binding?.packageGeneration === undefined || binding.instanceId !== instanceId || binding.proposal.kind !== "invoke") continue;
    const job = services.packageJobs.get(parsedId.data, {
      ownerPrincipalId: services.runtime.identity.ownerPrincipalId,
      instanceId,
      actionBindingId,
      packageGeneration: binding.packageGeneration,
    });
    if (job?.conversationId === conversationId && job.capabilityRef === binding.proposal.capabilityRef) {
      owned = job;
      break;
    }
  }
  if (owned === undefined) return fail(404, "JOB_NOT_FOUND", "that job is not available to this widget");

  if (request.method === "GET") return json(200, { job: snapshot(owned) });
  if (!services.packageJobs.cancel(parsedId.data, {
    ownerPrincipalId: services.runtime.identity.ownerPrincipalId,
    instanceId: owned.instanceId,
    actionBindingId: owned.actionBindingId,
    packageGeneration: owned.packageGeneration,
  })) {
    return fail(409, "JOB_NOT_RUNNING", "that job has already ended; its saved result is still available");
  }
  return json(202, { accepted: true, jobId: owned.jobId });
}
