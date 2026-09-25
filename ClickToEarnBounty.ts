import { expect } from "chai";
import { ethers } from "hardhat";
import type { Contract, Signer } from "ethers";

describe("ClickToEarnBounty", function () {
  let bounty: Contract;
  let nodl: Contract;

  let owner: Signer;
  let creator: Signer;
  let claimant: Signer;
  let oracle: Signer;
  let attacker: Signer;

  let ownerAddress: string;
  let creatorAddress: string;
  let claimantAddress: string;
  let oracleAddress: string;
  let attackerAddress: string;

  const REWARD = ethers.parseEther("100");

  const TARGET_H3 = ethers.keccak256(
    ethers.toUtf8Bytes("H3:click-to-earn-target")
  );

  const C2PA_ISSUER = ethers.keccak256(
    ethers.toUtf8Bytes("C2PA:trusted-issuer")
  );

  const CAMPAIGN_ID = ethers.keccak256(
    ethers.toUtf8Bytes("campaign-001")
  );

  const PROOF_HASH = ethers.keccak256(
    ethers.toUtf8Bytes("proof-001")
  );

  const EVIDENCE_ID = ethers.keccak256(
    ethers.toUtf8Bytes("evidence-001")
  );

  beforeEach(async function () {
    [
      owner,
      creator,
      claimant,
      oracle,
      attacker
    ] = await ethers.getSigners();

    ownerAddress = await owner.getAddress();
    creatorAddress = await creator.getAddress();
    claimantAddress = await claimant.getAddress();
    oracleAddress = await oracle.getAddress();
    attackerAddress = await attacker.getAddress();

    /*
     * Local mock NODL token.
     *
     * This represents the NODL ERC-20 during tests.
     */
    const MockNODL = await ethers.getContractFactory("MockNODL");

    nodl = await MockNODL.deploy();

    await nodl.waitForDeployment();

    const ClickToEarnBounty =
      await ethers.getContractFactory("ClickToEarnBounty");

    bounty = await ClickToEarnBounty.deploy(
      await nodl.getAddress(),
      oracleAddress
    );

    await bounty.waitForDeployment();

    /*
     * Give the creator enough test NODL.
     */
    await nodl.mint(
      creatorAddress,
      ethers.parseEther("10000")
    );
  });

  async function approveAndCreateBounty(
    expirationOffset = 3600
  ) {
    const latestBlock = await ethers.provider.getBlock("latest");

    if (!latestBlock) {
      throw new Error("Unable to read latest block");
    }

    const expiration =
      BigInt(latestBlock.timestamp) +
      BigInt(expirationOffset);

    await nodl
      .connect(creator)
      .approve(
        await bounty.getAddress(),
        REWARD
      );

    const tx = await bounty
      .connect(creator)
      .createBounty(
        REWARD,
        TARGET_H3,
        C2PA_ISSUER,
        CAMPAIGN_ID,
        expiration
      );

    await tx.wait();

    return {
      expiration
    };
  }

  describe("Deployment", function () {
    it("sets the NODL token", async function () {
      expect(
        await bounty.NODL()
      ).to.equal(await nodl.getAddress());
    });

    it("sets the owner", async function () {
      expect(
        await bounty.owner()
      ).to.equal(ownerAddress);
    });

    it("sets the oracle", async function () {
      expect(
        await bounty.oracle()
      ).to.equal(oracleAddress);
    });

    it("starts bounty IDs at zero", async function () {
      expect(
        await bounty.nextBountyId()
      ).to.equal(0);
    });
  });

  describe("Administration", function () {
    it("allows the owner to change the oracle", async function () {
      await bounty
        .connect(owner)
        .setOracle(attackerAddress);

      expect(
        await bounty.oracle()
      ).to.equal(attackerAddress);
    });

    it("rejects oracle changes from non-owner", async function () {
      await expect(
        bounty
          .connect(attacker)
          .setOracle(attackerAddress)
      )
        .to.be.revertedWith(
          "ClickToEarn: not owner"
        );
    });

    it("allows ownership transfer", async function () {
      await bounty
        .connect(owner)
        .transferOwnership(attackerAddress);

      expect(
        await bounty.owner()
      ).to.equal(attackerAddress);
    });

    it("rejects zero oracle", async function () {
      await expect(
        bounty
          .connect(owner)
          .setOracle(ethers.ZeroAddress)
      )
        .to.be.revertedWith(
          "ClickToEarn: zero oracle"
        );
    });

    it("rejects zero owner", async function () {
      await expect(
        bounty
          .connect(owner)
          .transferOwnership(ethers.ZeroAddress)
      )
        .to.be.revertedWith(
          "ClickToEarn: zero owner"
        );
    });
  });

  describe("Creating bounties", function () {
    it("escrows NODL", async function () {
      await approveAndCreateBounty();

      expect(
        await nodl.balanceOf(
          await bounty.getAddress()
        )
      ).to.equal(REWARD);
    });

    it("creates an active bounty", async function () {
      await approveAndCreateBounty();

      const stored = await bounty.getBounty(0);

      expect(stored.creator).to.equal(
        creatorAddress
      );

      expect(stored.reward).to.equal(
        REWARD
      );

      expect(stored.targetH3).to.equal(
        TARGET_H3
      );

      expect(stored.requiredC2paIssuer).to.equal(
        C2PA_ISSUER
      );

      expect(stored.campaignId).to.equal(
        CAMPAIGN_ID
      );

      expect(stored.status).to.equal(0);
    });

    it("increments the bounty ID", async function () {
      await approveAndCreateBounty();

      await approveAndCreateBounty();

      expect(
        await bounty.nextBountyId()
      ).to.equal(2);
    });

    it("rejects a zero reward", async function () {
      const latestBlock =
        await ethers.provider.getBlock("latest");

      if (!latestBlock) {
        throw new Error("No latest block");
      }

      const expiration =
        BigInt(latestBlock.timestamp) + 3600n;

      await expect(
        bounty
          .connect(creator)
          .createBounty(
            0,
            TARGET_H3,
            C2PA_ISSUER,
            CAMPAIGN_ID,
            expiration
          )
      )
        .to.be.revertedWith(
          "ClickToEarn: zero reward"
        );
    });

    it("rejects an expired deadline", async function () {
      await nodl
        .connect(creator)
        .approve(
          await bounty.getAddress(),
          REWARD
        );

      const latestBlock =
        await ethers.provider.getBlock("latest");

      if (!latestBlock) {
        throw new Error("No latest block");
      }

      const expiration =
        BigInt(latestBlock.timestamp) - 1n;

      await expect(
        bounty
          .connect(creator)
          .createBounty(
            REWARD,
            TARGET_H3,
            C2PA_ISSUER,
            CAMPAIGN_ID,
            expiration
          )
      )
        .to.be.revertedWith(
          "ClickToEarn: invalid expiration"
        );
    });

    it("rejects creation without sufficient allowance", async function () {
      const latestBlock =
        await ethers.provider.getBlock("latest");

      if (!latestBlock) {
        throw new Error("No latest block");
      }

      const expiration =
        BigInt(latestBlock.timestamp) + 3600n;

      await expect(
        bounty
          .connect(creator)
          .createBounty(
            REWARD,
            TARGET_H3,
            C2PA_ISSUER,
            CAMPAIGN_ID,
            expiration
          )
      )
        .to.be.reverted;
    });
  });

  describe("Oracle settlement", function () {
    beforeEach(async function () {
      await approveAndCreateBounty();
    });

    it("pays the claimant", async function () {
      await bounty
        .connect(oracle)
        .settleBounty(
          0,
          claimantAddress,
          PROOF_HASH,
          EVIDENCE_ID,
          TARGET_H3,
          C2PA_ISSUER
        );

      expect(
        await nodl.balanceOf(claimantAddress)
      ).to.equal(REWARD);
    });

    it("marks the bounty as settled", async function () {
      await bounty
        .connect(oracle)
        .settleBounty(
          0,
          claimantAddress,
          PROOF_HASH,
          EVIDENCE_ID,
          TARGET_H3,
          C2PA_ISSUER
        );

      const stored = await bounty.getBounty(0);

      expect(stored.status).to.equal(1);
      expect(stored.reward).to.equal(0);
    });

    it("stores the claim", async function () {
      await bounty
        .connect(oracle)
        .settleBounty(
          0,
          claimantAddress,
          PROOF_HASH,
          EVIDENCE_ID,
          TARGET_H3,
          C2PA_ISSUER
        );

      const claim =
        await bounty.getClaim(0);

      expect(claim.claimant).to.equal(
        claimantAddress
      );

      expect(claim.bountyId).to.equal(0);

      expect(claim.proofHash).to.equal(
        PROOF_HASH
      );

      expect(claim.evidenceId).to.equal(
        EVIDENCE_ID
      );
    });

    it("rejects settlement from an unauthorized account", async function () {
      await expect(
        bounty
          .connect(attacker)
          .settleBounty(
            0,
            claimantAddress,
            PROOF_HASH,
            EVIDENCE_ID,
            TARGET_H3,
            C2PA_ISSUER
          )
      )
        .to.be.revertedWith(
          "ClickToEarn: not oracle"
        );
    });

    it("rejects the wrong H3 location", async function () {
      const wrongH3 = ethers.keccak256(
        ethers.toUtf8Bytes("wrong-location")
      );

      await expect(
        bounty
          .connect(oracle)
          .settleBounty(
            0,
            claimantAddress,
            PROOF_HASH,
            EVIDENCE_ID,
            wrongH3,
            C2PA_ISSUER
          )
      )
        .to.be.revertedWith(
          "ClickToEarn: wrong H3"
        );
    });

    it("rejects the wrong C2PA issuer", async function () {
      const wrongIssuer = ethers.keccak256(
        ethers.toUtf8Bytes("untrusted-issuer")
      );

      await expect(
        bounty
          .connect(oracle)
          .settleBounty(
            0,
            claimantAddress,
            PROOF_HASH,
            EVIDENCE_ID,
            TARGET_H3,
            wrongIssuer
          )
      )
        .to.be.revertedWith(
          "ClickToEarn: wrong C2PA issuer"
        );
    });

    it("prevents proof replay", async function () {
      await bounty
        .connect(oracle)
        .settleBounty(
          0,
          claimantAddress,
          PROOF_HASH,
          EVIDENCE_ID,
          TARGET_H3,
          C2PA_ISSUER
        );

      await approveAndCreateBounty();

      await expect(
        bounty
          .connect(oracle)
          .settleBounty(
            1,
            claimantAddress,
            PROOF_HASH,
            ethers.keccak256(
              ethers.toUtf8Bytes("evidence-002")
            ),
            TARGET_H3,
            C2PA_ISSUER
          )
      )
        .to.be.revertedWith(
          "ClickToEarn: proof already used"
        );
    });

    it("prevents evidence replay", async function () {
      await bounty
        .connect(oracle)
        .settleBounty(
          0,
          claimantAddress,
          PROOF_HASH,
          EVIDENCE_ID,
          TARGET_H3,
          C2PA_ISSUER
        );

      await approveAndCreateBounty();

      await expect(
        bounty
          .connect(oracle)
          .settleBounty(
            1,
            claimantAddress,
            ethers.keccak256(
              ethers.toUtf8Bytes("proof-002")
            ),
            EVIDENCE_ID,
            TARGET_H3,
            C2PA_ISSUER
          )
      )
        .to.be.revertedWith(
          "ClickToEarn: evidence already used"
        );
    });

    it("rejects a second settlement", async function () {
      await bounty
        .connect(oracle)
        .settleBounty(
          0,
          claimantAddress,
          PROOF_HASH,
          EVIDENCE_ID,
          TARGET_H3,
          C2PA_ISSUER
        );

      await expect(
        bounty
          .connect(oracle)
          .settleBounty(
            0,
            claimantAddress,
            ethers.keccak256(
              ethers.toUtf8Bytes("proof-002")
            ),
            ethers.keccak256(
              ethers.toUtf8Bytes("evidence-002")
            ),
            TARGET_H3,
            C2PA_ISSUER
          )
      )
        .to.be.revertedWith(
          "ClickToEarn: bounty inactive"
        );
    });
  });

  describe("Expiration", function () {
    it("allows the creator to reclaim an expired bounty", async function () {
      await approveAndCreateBounty(1);

      await ethers.provider.send(
        "evm_increaseTime",
        [2]
      );

      await ethers.provider.send(
        "evm_mine",
        []
      );

      const before =
        await nodl.balanceOf(creatorAddress);

      await bounty
        .connect(creator)
        .reclaimExpiredBounty(0);

      const after =
        await nodl.balanceOf(creatorAddress);

      expect(after - before).to.equal(
        REWARD
      );

      const stored =
        await bounty.getBounty(0);

      expect(stored.status).to.equal(2);
      expect(stored.reward).to.equal(0);
    });

    it("rejects expiration reclaim before the deadline", async function () {
      await approveAndCreateBounty();

      await expect(
        bounty
          .connect(creator)
          .reclaimExpiredBounty(0)
      )
        .to.be.revertedWith(
          "ClickToEarn: not expired"
        );
    });

    it("rejects expiration reclaim from another account", async function () {
      await approveAndCreateBounty(1);

      await ethers.provider.send(
        "evm_increaseTime",
        [2]
      );

      await ethers.provider.send(
        "evm_mine",
        []
      );

      await expect(
        bounty
          .connect(attacker)
          .reclaimExpiredBounty(0)
      )
        .to.be.revertedWith(
          "ClickToEarn: not creator"
        );
    });
  });

  describe("Cancellation", function () {
    it("allows the creator to cancel an active bounty", async function () {
      await approveAndCreateBounty();

      const before =
        await nodl.balanceOf(creatorAddress);

      await bounty
        .connect(creator)
        .cancelBounty(0);

      const after =
        await nodl.balanceOf(creatorAddress);

      expect(after - before).to.equal(
        REWARD
      );

      const stored =
        await bounty.getBounty(0);

      expect(stored.status).to.equal(3);
      expect(stored.reward).to.equal(0);
    });

    it("rejects cancellation from another account", async function () {
      await approveAndCreateBounty();

      await expect(
        bounty
          .connect(attacker)
          .cancelBounty(0)
      )
        .to.be.revertedWith(
          "ClickToEarn: not creator"
        );
    });

    it("prevents cancellation after settlement", async function () {
      await approveAndCreateBounty();

      await bounty
        .connect(oracle)
        .settleBounty(
          0,
          claimantAddress,
          PROOF_HASH,
          EVIDENCE_ID,
          TARGET_H3,
          C2PA_ISSUER
        );

      await expect(
        bounty
          .connect(creator)
          .cancelBounty(0)
      )
        .to.be.revertedWith(
          "ClickToEarn: bounty inactive"
        );
    });
  });

  describe("View functions", function () {
    it("reports whether a bounty exists", async function () {
      expect(
        await bounty.bountyExists(0)
      ).to.equal(false);

      await approveAndCreateBounty();

      expect(
        await bounty.bountyExists(0)
      ).to.equal(true);
    });

    it("reports the escrowed NODL balance", async function () {
      expect(
        await bounty.contractNodlBalance()
      ).to.equal(0);

      await approveAndCreateBounty();

      expect(
        await bounty.contractNodlBalance()
      ).to.equal(REWARD);
    });
  });
});


/**
 * Simple ERC-20 mock used exclusively by the test suite.
 *
 * Save this portion as:
 *
 * contracts/MockNODL.sol
 *
 * when running the tests.
 */

Important: the test expects a local "MockNODL.sol". Add this alongside the contract:

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockNODL {
    string public name = "Mock NODL";
    string public symbol = "mNODL";
    uint8 public decimals = 18;

    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(
        address to,
        uint256 amount
    ) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(
        address spender,
        uint256 amount
    ) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(
        address to,
        uint256 amount
    ) external returns (bool) {
        require(
            balanceOf[msg.sender] >= amount,
            "MockNODL: insufficient balance"
        );

        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;

        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        require(
            balanceOf[from] >= amount,
            "MockNODL: insufficient balance"
        );

        require(
            allowance[from][msg.sender] >= amount,
            "MockNODL: insufficient allowance"
        );

        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;

        return true;
    }
}

Place the test at:

click-to-earn-bounty/
├── contracts/
│   ├── ClickToEarnBounty.sol
│   └── MockNODL.sol
└── test/
    └── ClickToEarnBounty.ts

Then run:

npm install
npx hardhat compile
npx hardhat test

This gives you a local test harness before connecting the contract to the real NODL token on zkSync Era.