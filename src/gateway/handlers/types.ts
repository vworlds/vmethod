import type { GatewayServices } from "../server.js";
import type { Handlers, Operations } from "../transport.js";

/** A gateway operation using the services built by the composition root. */
export type Handler<K extends keyof Operations> = (
  this: GatewayServices,
  ...args: Parameters<Handlers[K]>
) => ReturnType<Handlers[K]>;
