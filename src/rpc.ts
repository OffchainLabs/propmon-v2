import { JsonRpcProvider } from "@ethersproject/providers";
import { Log, Filter } from "@ethersproject/abstract-provider";
import { providers } from "ethers";

export const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

// overridden once at startup from env config
export const tuning = { getLogsWaitMs: 5000 };

const transientMessages = [
  "header not found",
  "block not found",
  "rate limit",
  "too many requests",
  "timed out",
  "timeout",
];

const connectionCodes = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ENOTFOUND"];

export function isTransientRpcError(e: any): boolean {
  if (e.code === "TIMEOUT") return true;
  if (connectionCodes.includes(e.code)) return true;
  // http error: transient unless a 4xx other than 429
  if (e.code === "SERVER_ERROR") {
    const status = e.status;
    return typeof status !== "number" || status === 429 || status >= 500;
  }
  if (e.code === -32005) return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return transientMessages.some((m) => msg.includes(m));
}

export type RetryConfig = { retryCount: number; retryIntervalMs: number };

// retries transient rpc errors; everything else (reverts, nonce/funds errors, ...) throws.
// eth_getLogs is exempt: the bisecting getLogs helper below is its only retry path.
export class RetryJsonRpcProvider extends JsonRpcProvider {
  constructor(url: string, public readonly retry: RetryConfig) {
    super(url);
  }

  async send(method: string, params: any[]): Promise<any> {
    if (method === "eth_getLogs") return super.send(method, params);
    for (let attempt = 0; ; attempt++) {
      try {
        return await super.send(method, params);
      } catch (e) {
        if (attempt >= this.retry.retryCount || !isTransientRpcError(e)) throw e;
        await wait(this.retry.retryIntervalMs);
      }
    }
  }
}

// any failure bisects the range; a failure on a single block throws.
// sequential left-then-right recursion keeps logs in order.
export async function getLogs(
  provider: providers.Provider,
  filter: Omit<Filter, "fromBlock" | "toBlock">,
  fromBlock: number,
  toBlock: number
): Promise<Log[]> {
  try {
    return await provider.getLogs({ ...filter, fromBlock, toBlock });
  } catch (e) {
    if (fromBlock === toBlock) throw e;
    await wait(tuning.getLogsWaitMs);
    const mid = Math.floor((fromBlock + toBlock) / 2);
    return [
      ...(await getLogs(provider, filter, fromBlock, mid)),
      ...(await getLogs(provider, filter, mid + 1, toBlock)),
    ];
  }
}
