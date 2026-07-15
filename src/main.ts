import { Wallet } from "ethers";
import { RetryJsonRpcProvider, wait } from "./rpc";
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

async function main() {
  const pollMs = envInt("POLL_INTERVAL_SECONDS", 60) * 1000;
  const retry = {
    retryCount: envInt("RPC_RETRY_COUNT", 5),
    retryIntervalMs: envInt("RPC_RETRY_INTERVAL_SECONDS", 5) * 1000,
    getLogsWaitMs: envInt("GETLOGS_WAIT_SECONDS", 5) * 1000,
  };

  const key = env("PROPMON_PRIVATE_KEY");
  const ethProvider = new RetryJsonRpcProvider(env("ETH_RPC_URL"), retry);
  const arbProvider = new RetryJsonRpcProvider(env("ARB_RPC_URL"), retry);
  const novaProvider = new RetryJsonRpcProvider(env("NOVA_RPC_URL"), retry);
  const ethSigner = new Wallet(key, ethProvider);
  const arbSigner = new Wallet(key, arbProvider);
  const novaSigner = new Wallet(key, novaProvider);

  const healthcheckUrl = process.env.PROPMON_HEALTHCHECK_URL;
  const arbStartBlock = envInt("ARB_START_BLOCK");
  const ethStartBlock = envInt("ETH_START_BLOCK");
  const l2Timelock = env("L2_TIMELOCK");
  const l1Timelock = env("L1_TIMELOCK");
  const l1UpgradeExecutor = env("L1_UPGRADE_EXECUTOR");

  const stages: Stage[] = [
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

  info("starting", {
    signer: await ethSigner.getAddress(),
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
