import { readFileSync } from "fs";
import { parse, ParseError, printParseErrorCode } from "jsonc-parser";
import { Wallet } from "ethers";
import { RetryJsonRpcProvider, RetryConfig } from "./rpc";
import { Stage } from "./stage";
import { GovernorStage, QueueGovernorStage, NomineeGovernorStage } from "./governorStage";
import { TimelockStage } from "./timelockStage";
import { OutboxStage } from "./outboxStage";
import { RetryableStage } from "./retryableStage";

const ARB_SYS = "0x0000000000000000000000000000000000000064";

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name}`);
  return v;
}

export function envInt(name: string, fallback?: number): number {
  const v = process.env[name];
  if (!v) {
    if (fallback === undefined) throw new Error(`missing env var ${name}`);
    return fallback;
  }
  return parseInt(v);
}

// startBlock is required on chains any stage finds events on
type ChainConfig = { rpcUrlEnv: string; startBlock?: number };

type StageConfig =
  | {
      type: "governor" | "queue-governor" | "nominee-governor" | "timelock";
      chain: string;
      address: string;
    }
  | {
      type: "outbox";
      address: string; // the L1 outbox
      l2Chain: string;
      l1Chain: string;
      l2Caller: string;
      l1Destination: string;
    }
  | {
      type: "retryable";
      address: string; // the L1 bridge
      l1Chain: string;
      l2Chain: string;
      l1Timelock: string;
      l1UpgradeExecutor: string;
    };

type Config = { chains: Record<string, ChainConfig>; stages: StageConfig[] };

type Chain = { config: ChainConfig; signer: Wallet };

export function loadStages(configPath: string, retry: RetryConfig): Stage[] {
  const errors: ParseError[] = [];
  const config: Config = parse(readFileSync(configPath, "utf8"), errors);
  if (errors.length)
    throw new Error(
      `${configPath}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`
    );
  const key = env("PROPMON_PRIVATE_KEY");

  const chains = new Map<string, Chain>();
  for (const [name, chainConfig] of Object.entries(config.chains)) {
    const provider = new RetryJsonRpcProvider(env(chainConfig.rpcUrlEnv), retry);
    chains.set(name, { config: chainConfig, signer: new Wallet(key, provider) });
  }

  const chain = (name: string): Chain => {
    const c = chains.get(name);
    if (!c) throw new Error(`stage references unknown chain ${name}`);
    return c;
  };
  // stages scan from the start block of the chain findEvents runs on
  const startBlock = (name: string): number => {
    const b = chain(name).config.startBlock;
    if (b === undefined) throw new Error(`chain ${name} needs a startBlock`);
    return b;
  };

  return config.stages.map((s) => {
    switch (s.type) {
      case "governor":
        return new GovernorStage(s.address, chain(s.chain).signer, startBlock(s.chain));
      case "queue-governor":
        return new QueueGovernorStage(s.address, chain(s.chain).signer, startBlock(s.chain));
      case "nominee-governor":
        return new NomineeGovernorStage(s.address, chain(s.chain).signer, startBlock(s.chain));
      case "timelock":
        return new TimelockStage(s.address, chain(s.chain).signer, startBlock(s.chain));
      case "outbox":
        return new OutboxStage(
          ARB_SYS,
          s.l2Caller,
          s.l1Destination,
          chain(s.l2Chain).signer.provider!,
          s.address,
          chain(s.l1Chain).signer,
          startBlock(s.l2Chain)
        );
      case "retryable":
        return new RetryableStage(
          s.address,
          s.l1Timelock,
          s.l1UpgradeExecutor,
          chain(s.l1Chain).signer.provider!,
          chain(s.l2Chain).signer,
          startBlock(s.l1Chain)
        );
    }
    throw new Error(
      `unknown stage type ${
        (s as StageConfig).type
      } (governor | queue-governor | nominee-governor | timelock | outbox | retryable)`
    );
  });
}
