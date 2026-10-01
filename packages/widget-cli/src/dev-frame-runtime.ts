import { createWidgetRuntime, type MessageEndpoint } from "@clarkcant/widget-sdk";

const listeners = new Map<(event: { data: unknown }) => void, (event: MessageEvent) => void>();
const endpoint: MessageEndpoint = {
  postMessage: (message) => window.parent.postMessage(message, "*"),
  addEventListener: (_type, listener) => {
    const receive = (event: MessageEvent): void => listener({ data: event.data });
    listeners.set(listener, receive);
    window.addEventListener("message", receive);
  },
  removeEventListener: (_type, listener) => {
    const receive = listeners.get(listener);
    if (receive !== undefined) window.removeEventListener("message", receive);
    listeners.delete(listener);
  },
};

const runtime = createWidgetRuntime({ endpoint });
(window as unknown as { clarkcantWidget: typeof runtime }).clarkcantWidget = runtime;
