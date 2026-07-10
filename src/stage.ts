import { Log, Filter } from "@ethersproject/abstract-provider";
import { providers } from "ethers";
import { getLogs } from "./rpc";

export const VERDICTS = ["handled", "skipped", "waiting", "dead"] as const;
export type Verdict = (typeof VERDICTS)[number];

export type HandleResult = Record<Verdict, Log[]>;

export interface IStage {
  address: string;
  stageType(): string;
  findEvents(): Promise<Log[]>;
  handleEvents(): Promise<HandleResult>;
}

export abstract class Stage implements IStage {
  protected toHandle: Log[] = [];
  protected lastScanned: number;

  constructor(
    public readonly address: string,
    public readonly findProvider: providers.Provider,
    startBlock: number
  ) {
    this.lastScanned = startBlock - 1;
  }

  stageType(): string {
    return this.constructor.name;
  }

  protected abstract findFilter(): Omit<Filter, "fromBlock" | "toBlock">;

  // drop unrelated logs the rpc filter could not exclude
  protected async filterFound(logs: Log[]): Promise<Log[]> {
    return logs;
  }

  async findEvents(): Promise<Log[]> {
    const latest = await this.findProvider.getBlockNumber();
    if (latest <= this.lastScanned) return [];
    const logs = await getLogs(this.findProvider, this.findFilter(), this.lastScanned + 1, latest);
    const found = await this.filterFound(logs);
    this.lastScanned = latest;
    this.toHandle.push(...found);
    return found;
  }

  protected abstract handleLog(log: Log): Promise<Verdict>;

  async handleEvents(): Promise<HandleResult> {
    const res: HandleResult = { handled: [], skipped: [], waiting: [], dead: [] };
    for (const log of [...this.toHandle]) {
      const verdict = await this.handleLog(log);
      res[verdict].push(log);
      if (verdict !== "waiting") this.toHandle.splice(this.toHandle.indexOf(log), 1);
    }
    return res;
  }
}
