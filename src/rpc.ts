import { JsonRpcProvider } from "@ethersproject/providers";
import { debug, warn } from "./log";

export const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

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
  if (e.code === "SERVER_ERROR") {
    // http error: transient unless a 4xx other than 429
    if (typeof e.status === "number") return e.status === 429 || e.status >= 500;
    // http 200 with a json-rpc error body (e.g. a revert): classify by the inner error
    if (e.error) return isTransientRpcError(e.error);
    return true;
  }
  if (e.code === -32005) return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return transientMessages.some((m) => msg.includes(m));
}

export type RetryConfig = { retryCount: number; retryIntervalMs: number; getLogsWaitMs: number };

// retries transient rpc errors; everything else (reverts, nonce/funds errors, ...) throws.
// a failed eth_getLogs first bisects its block range
export class RetryJsonRpcProvider extends JsonRpcProvider {
  constructor(url: string, public readonly retry: RetryConfig) {
    super(url);
  }

  // halves of a failed getLogs filter, resolving absent/"latest" bounds once; null
  // when unsplittable (single block, or a tag we can't resolve), letting the
  // original error flow through the retry/classify path in send()
  private async bisect(filter: any): Promise<[any, any] | null> {
    const parseBlock = async (b: string | number | null | undefined) => {
      if (b === null || b === undefined || b === "latest") return await this.getBlockNumber();
      if (typeof b === "number") return b;
      if (typeof b === "string" && b.startsWith("0x")) return parseInt(b, 16);
      return null;
    };
    const from = await parseBlock(filter.fromBlock);
    const to = await parseBlock(filter.toBlock);
    if (from === null || to === null || from >= to) return null;
    const mid = Math.floor((from + to) / 2);
    const hex = (n: number) => "0x" + n.toString(16);
    return [
      { ...filter, fromBlock: hex(from), toBlock: hex(mid) },
      { ...filter, fromBlock: hex(mid + 1), toBlock: hex(to) },
    ];
  }

  async send(method: string, params: any[]): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await super.send(method, params);
      } catch (e) {
        if (method === "eth_getLogs") {
          const halves = await this.bisect(params[0]);
          if (halves) {
            debug("getLogs failed, bisecting", {
              fromBlock: params[0].fromBlock,
              toBlock: params[0].toBlock,
              error: (e as Error).message,
            });
            await wait(this.retry.getLogsWaitMs);
            // sequential left-then-right recursion keeps logs in order
            return [
              ...(await this.send(method, [halves[0]])),
              ...(await this.send(method, [halves[1]])),
            ];
          }
        }
        if (attempt >= this.retry.retryCount || !isTransientRpcError(e)) throw e;
        warn("transient rpc error, retrying", {
          method,
          attempt: attempt + 1,
          error: (e as Error).message,
        });
        await wait(this.retry.retryIntervalMs);
      }
    }
  }
}
