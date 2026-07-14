import { BigNumber, Contract, ContractTransaction, Signer, providers } from "ethers";
import { id } from "ethers/lib/utils";
import { Log } from "@ethersproject/abstract-provider";
import { Result } from "@ethersproject/abi";
import {
  L2ArbitrumGovernor,
  L2ArbitrumGovernor__factory,
  SecurityCouncilNomineeElectionGovernor__factory,
} from "../typechain-types";
import { Stage, Verdict } from "./stage";
import { debug, info } from "./log";

const govInterface = L2ArbitrumGovernor__factory.createInterface();

enum ProposalState {
  Pending,
  Active,
  Canceled,
  Defeated,
  Succeeded,
  Queued,
  Expired,
  Executed,
}

// executes proposals as soon as the vote succeeds (member election governor)
export class GovernorStage extends Stage {
  protected readonly governor: L2ArbitrumGovernor;

  constructor(address: string, protected readonly signer: Signer, startBlock: number) {
    super(address, signer.provider!, startBlock);
    this.governor = L2ArbitrumGovernor__factory.connect(address, signer);
  }

  protected findFilter() {
    return this.governor.filters.ProposalCreated();
  }

  protected async handleLog(log: Log): Promise<Verdict> {
    const args = govInterface.parseLog(log).args;
    const proposalId = args.proposalId.toString();
    const state: ProposalState = await this.governor.state(args.proposalId);
    debug("proposal state", {
      type: this.stageType(),
      address: this.address,
      proposalId,
      state: ProposalState[state],
    });
    if (state === ProposalState.Queued || state === ProposalState.Executed) return "skipped";
    if (
      state === ProposalState.Canceled ||
      state === ProposalState.Defeated ||
      state === ProposalState.Expired
    )
      return "dead";
    if (state === ProposalState.Pending || state === ProposalState.Active) return "waiting";
    if (!(await this.readyToExecute(args.proposalId))) return "waiting";
    const tx = await this.act(args);
    await tx.wait();
    info("proposal handled", {
      type: this.stageType(),
      address: this.address,
      proposalId,
      tx: tx.hash,
    });
    return "handled";
  }

  protected async readyToExecute(proposalId: BigNumber): Promise<boolean> {
    return true;
  }

  protected act(args: Result): Promise<ContractTransaction> {
    // args[3] is the values array; .values collides with Result's built-in method
    return this.governor.execute(args.targets, args[3], args.calldatas, id(args.description));
  }
}

// queues on the governor's timelock instead of executing (core, treasury)
export class QueueGovernorStage extends GovernorStage {
  protected act(args: Result): Promise<ContractTransaction> {
    return this.governor.queue(args.targets, args[3], args.calldatas, id(args.description));
  }
}

// also waits for the vetting deadline (an L1 block number) before execute()
export class NomineeGovernorStage extends GovernorStage {
  protected async readyToExecute(proposalId: BigNumber): Promise<boolean> {
    const gov = SecurityCouncilNomineeElectionGovernor__factory.connect(
      this.governor.address,
      this.signer
    );
    const deadline = await gov.proposalVettingDeadline(proposalId);
    return (await l1BlockNumber(this.findProvider)).gt(deadline);
  }
}

const ARB_ONE_MULTICALL = "0x7eCfBaa8742fDf5756DAC92fbc8b90a19b8815bF";

// on arbitrum block.number is the L1 block number; read it via a contract call
const l1BlockNumber = (provider: providers.Provider): Promise<BigNumber> =>
  new Contract(
    ARB_ONE_MULTICALL,
    ["function getL1BlockNumber() view returns (uint256)"],
    provider
  ).getL1BlockNumber();
