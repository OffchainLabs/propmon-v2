import { Wallet } from "ethers";
import { RetryJsonRpcProvider, RetryConfig, wait } from "./rpc";
import { info, warn } from "./log";
import { Stage, VERDICTS } from "./stage";
import { GovernorStage, QueueGovernorStage, NomineeGovernorStage } from "./governorStage";
import { TimelockStage } from "./timelockStage";
import { OutboxStage } from "./outboxStage";
import { RetryableStage } from "./retryableStage";

const ARB_SYS = "0x0000000000000000000000000000000000000064";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name}`);
  return v;
}

function envInt(name: string, fallback?: number): number {
  const v = process.env[name];
  if (!v) {
    if (fallback === undefined) throw new Error(`missing env var ${name}`);
    return fallback;
  }
  return parseInt(v);
}

function fullGovernanceStages(retry: RetryConfig): Stage[] {
  const key = env("PROPMON_PRIVATE_KEY");
  const ethProvider = new RetryJsonRpcProvider(env("ETH_RPC_URL"), retry);
  const arbProvider = new RetryJsonRpcProvider(env("ARB_RPC_URL"), retry);
  const novaProvider = new RetryJsonRpcProvider(env("NOVA_RPC_URL"), retry);
  const ethSigner = new Wallet(key, ethProvider);
  const arbSigner = new Wallet(key, arbProvider);
  const novaSigner = new Wallet(key, novaProvider);

  const arbStartBlock = envInt("ARB_START_BLOCK");
  const ethStartBlock = envInt("ETH_START_BLOCK");
  const l2Timelock = env("L2_TIMELOCK");
  const l1Timelock = env("L1_TIMELOCK");
  const l1UpgradeExecutor = env("L1_UPGRADE_EXECUTOR");

  return [
    new QueueGovernorStage(env("CORE_GOVERNOR"), arbSigner, arbStartBlock),
    new QueueGovernorStage(env("TREASURY_GOVERNOR"), arbSigner, arbStartBlock),
    new NomineeGovernorStage(env("NOMINEE_ELECTION_GOVERNOR"), arbSigner, arbStartBlock),
    new GovernorStage(env("MEMBER_ELECTION_GOVERNOR"), arbSigner, arbStartBlock),
    new TimelockStage(l2Timelock, arbSigner, arbStartBlock),
    new OutboxStage(
      ARB_SYS,
      l2Timelock,
      l1Timelock,
      arbProvider,
      env("L1_OUTBOX"),
      ethSigner,
      arbStartBlock
    ),
    new TimelockStage(l1Timelock, ethSigner, ethStartBlock),
    new RetryableStage(env("ARB_BRIDGE"), l1Timelock, l1UpgradeExecutor, ethProvider, arbSigner, ethStartBlock),
    new RetryableStage(env("NOVA_BRIDGE"), l1Timelock, l1UpgradeExecutor, ethProvider, novaSigner, ethStartBlock),
  ];
}

function individualStage(retry: RetryConfig): Stage {
  const key = env("PROPMON_PRIVATE_KEY");
  const type = env("STAGE_TYPE");
  const address = env("STAGE_ADDRESS");
  const startBlock = envInt("START_BLOCK");

  switch (type) {
    case "governor":
    case "queue-governor":
    case "nominee-governor":
    case "timelock": {
      const signer = new Wallet(key, new RetryJsonRpcProvider(env("RPC_URL"), retry));
      if (type === "governor") return new GovernorStage(address, signer, startBlock);
      if (type === "queue-governor") return new QueueGovernorStage(address, signer, startBlock);
      if (type === "nominee-governor") return new NomineeGovernorStage(address, signer, startBlock);
      return new TimelockStage(address, signer, startBlock);
    }
    case "outbox": {
      const l2Provider = new RetryJsonRpcProvider(env("L2_RPC_URL"), retry);
      const l1Signer = new Wallet(key, new RetryJsonRpcProvider(env("L1_RPC_URL"), retry));
      return new OutboxStage(
        ARB_SYS,
        env("L2_CALLER"),
        env("L1_DESTINATION"),
        l2Provider,
        address,
        l1Signer,
        startBlock
      );
    }
    case "retryable": {
      const l1Provider = new RetryJsonRpcProvider(env("L1_RPC_URL"), retry);
      const l2Signer = new Wallet(key, new RetryJsonRpcProvider(env("L2_RPC_URL"), retry));
      return new RetryableStage(
        address,
        env("L1_TIMELOCK"),
        env("L1_UPGRADE_EXECUTOR"),
        l1Provider,
        l2Signer,
        startBlock
      );
    }
  }
  throw new Error(
    `unknown STAGE_TYPE ${type} (governor | queue-governor | nominee-governor | timelock | outbox | retryable)`
  );
}

async function main() {
  const mode = process.env.PROPMON_MODE ?? "arb-full-governance";
  const pollMs = envInt("POLL_INTERVAL_SECONDS", 60) * 1000;
  const retry = {
    retryCount: envInt("RPC_RETRY_COUNT", 5),
    retryIntervalMs: envInt("RPC_RETRY_INTERVAL_SECONDS", 5) * 1000,
    getLogsWaitMs: envInt("GETLOGS_WAIT_SECONDS", 5) * 1000,
  };

  let stages: Stage[];
  if (mode === "arb-full-governance") stages = fullGovernanceStages(retry);
  else if (mode === "individual-stage") stages = [individualStage(retry)];
  else throw new Error(`unknown PROPMON_MODE ${mode} (arb-full-governance | individual-stage)`);

  const healthcheckUrl = process.env.PROPMON_HEALTHCHECK_URL;

  info("starting", {
    mode,
    signer: new Wallet(env("PROPMON_PRIVATE_KEY")).address,
    pollSeconds: pollMs / 1000,
    stages: stages.map((s) => `${s.stageType()}:${s.address}`),
  });

  while (true) {
    for (const stage of stages) {
      const ctx = { type: stage.stageType(), address: stage.address };
      for (const log of await stage.findEvents()) info("found", { ...ctx, log });
      const res = await stage.handleEvents();
      for (const kind of VERDICTS) {
        for (const log of res[kind]) info(kind, { ...ctx, log });
      }
    }
    // only reached if every stage succeeded; a ping signals a fully successful iteration
    if (healthcheckUrl)
      fetch(healthcheckUrl).catch((e) => warn("healthcheck ping failed", { error: String(e) }));
    info("iteration complete");
    await wait(pollMs);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
