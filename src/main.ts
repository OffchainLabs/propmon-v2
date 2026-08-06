import { Wallet } from "ethers";
import { wait } from "./rpc";
import { info, warn } from "./log";
import { VERDICTS } from "./stage";
import { loadStages, env, envInt } from "./config";

async function main() {
  const configPath = process.env.PROPMON_CONFIG ?? "config/arb1-governance.jsonc";
  const pollMs = envInt("POLL_INTERVAL_SECONDS", 60) * 1000;
  const retry = {
    retryCount: envInt("RPC_RETRY_COUNT", 5),
    retryIntervalMs: envInt("RPC_RETRY_INTERVAL_SECONDS", 5) * 1000,
    getLogsWaitMs: envInt("GETLOGS_WAIT_SECONDS", 5) * 1000,
  };

  const stages = loadStages(configPath, retry);
  const healthcheckUrl = process.env.PROPMON_HEALTHCHECK_URL;

  info("starting", {
    config: configPath,
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
