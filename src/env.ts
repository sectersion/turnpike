import type { Hub } from "./hub";

export interface Env {
  HUB: DurableObjectNamespace<Hub>;
  ADMIN_TOKEN?: string;
  ASSETS: Fetcher;
}
