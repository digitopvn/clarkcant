/**
 * @clarkcant/runtime
 *
 * Headless node: composition root, node identity and the authenticated command gateway.
 * This is the package a desktop helper and a VPS install both run; Electron is never a
 * requirement here, which is what makes the same code serve both.
 *
 * `main.ts` is the process entry point (`node apps/runtime/src/main.ts`). This module is
 * the importable surface, so tests and embedders can drive the gateway without a socket.
 */

export { bootRuntime, runtimeDescription, LOCAL_SOCKET_STATUS, type NodeIdentity, type Runtime, type RuntimeOptions } from "./node.ts";
export { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "./gateway.ts";
export { createNodeServer, type NodeServerOptions } from "./server.ts";
export { bootNodeServices, type NodeServices } from "./services.ts";
export { attachApiSocket, sseParser, type ApiSocket } from "./api-socket.ts";
export {
  API_SOCKET_PATH,
  API_SOCKET_PROTOCOL,
  DISCOVERY_PATH,
  MCP_PATH,
  MCP_PROTOCOL_VERSIONS,
  OPENAPI_PATH,
  discoveryDocument,
  openApiDocument,
} from "./open-interfaces.ts";
