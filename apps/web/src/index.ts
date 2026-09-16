/**
 * @clarkcant/app-web
 *
 * Browser client: mounts `@clarkcant/conversation-client` against the runtime gateway
 * over HTTPS and WSS. Deliberately has no Node dependency, so the same components can be
 * hosted by the desktop shell.
 *
 * @implementation-status stub
 * TODO(P1): the Vite entry point, the gateway transport (fetch for commands, WebSocket
 * for events with a reconnect cursor) and the HTML shell. The gateway it talks to is
 * implemented and tested in `apps/runtime`; this client is not.
 *
 * Note the deployment requirement the blueprint is explicit about: browser features that
 * need a secure context require HTTPS, and loopback development is not the same
 * configuration as a deployment.
 */

/** Routes the client renders. One conversation; no session picker by design. */
export const ROUTES = ["/", "/conversation/:conversationId"] as const;

/**
 * @implementation-status stub
 * TODO(P1): see above.
 */
export const WEB_CLIENT_STATUS = "not-implemented";
