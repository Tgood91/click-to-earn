// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ClickToEarnBounty
 *
 * Designed for zkSync Era.
 *
 * Flow:
 *  1. Creator approves this contract to spend NODL.
 *  2. Creator creates a bounty.
 *  3. User performs the required action / submits evidence.
 *  4. Off-chain verifier checks C2PA, location, device/provenance, etc.
 *  5. Authorized oracle settles the bounty.
 *  6. Contract transfers the escrowed NODL to the claimant.
 *
 * The contract does NOT attempt to verify C2PA or GPS itself.
 * Those proofs are represented by hashes/attestations supplied by
 * the authorized verifier.
 */

interface IERC20 {
    function transfer(
        address to,
        uint256 amount
    ) external returns (bool);

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);

    function balanceOf(
        address account
    ) external view returns (uint256);

    function allowance(
        address owner,
        address spender
    ) external view returns (uint256);
}

contract ClickToEarnBounty {

    // ------------------------------------------------------------
    // Types
    // ------------------------------------------------------------

    enum BountyStatus {
        Active,
        Settled,
        Expired,
        Cancelled
    }

    struct Bounty {
        address creator;

        // Escrowed NODL
        uint256 reward;

        // Geographic target represented as an H3 index hash.
        bytes32 targetH3;

        // Required C2PA issuer hash.
        bytes32 requiredC2paIssuer;

        // Optional campaign identifier.
        bytes32 campaignId;

        // Claim deadline.
        uint64 expiration;

        BountyStatus status;
    }

    struct Claim {
        address claimant;

        uint256 bountyId;

        // Hash of the verified evidence bundle.
        bytes32 proofHash;

        // Hash identifying the device/session/event.
        bytes32 evidenceId;

        // Timestamp at which oracle settled.
        uint64 timestamp;
    }

    // ------------------------------------------------------------
    // State
    // ------------------------------------------------------------

    IERC20 public immutable NODL;

    address public owner;

    /**
     * Authorized verifier.
     *
     * This address represents the off-chain oracle that validates:
     * - C2PA
     * - H3 location
     * - device/provenance
     * - anti-replay evidence
     */
    address public oracle;

    uint256 public nextBountyId;

    mapping(uint256 => Bounty) public bounties;

    mapping(uint256 => Claim) public claims;

    /**
     * Prevent the same evidence from being paid twice.
     */
    mapping(bytes32 => bool) public usedProofs;

    /**
     * Optional anti-replay protection for individual evidence IDs.
     */
    mapping(bytes32 => bool) public usedEvidence;

    // ------------------------------------------------------------
    // Events
    // ------------------------------------------------------------

    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    event OracleUpdated(
        address indexed previousOracle,
        address indexed newOracle
    );

    event BountyCreated(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 reward,
        bytes32 targetH3,
        bytes32 requiredC2paIssuer,
        bytes32 campaignId,
        uint64 expiration
    );

    event BountySettled(
        uint256 indexed bountyId,
        address indexed claimant,
        uint256 reward,
        bytes32 proofHash,
        bytes32 evidenceId
    );

    event BountyExpired(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 refund
    );

    event BountyCancelled(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 refund
    );

    // ------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "ClickToEarn: not owner");
        _;
    }

    modifier onlyOracle() {
        require(msg.sender == oracle, "ClickToEarn: not oracle");
        _;
    }

    // ------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------

    constructor(
        address nodlToken,
        address initialOracle
    ) {
        require(
            nodlToken != address(0),
            "ClickToEarn: zero NODL"
        );

        require(
            initialOracle != address(0),
            "ClickToEarn: zero oracle"
        );

        NODL = IERC20(nodlToken);

        owner = msg.sender;
        oracle = initialOracle;

        emit OwnershipTransferred(
            address(0),
            msg.sender
        );

        emit OracleUpdated(
            address(0),
            initialOracle
        );
    }

    // ------------------------------------------------------------
    // Administration
    // ------------------------------------------------------------

    function setOracle(
        address newOracle
    ) external onlyOwner {

        require(
            newOracle != address(0),
            "ClickToEarn: zero oracle"
        );

        address previous = oracle;

        oracle = newOracle;

        emit OracleUpdated(
            previous,
            newOracle
        );
    }

    function transferOwnership(
        address newOwner
    ) external onlyOwner {

        require(
            newOwner != address(0),
            "ClickToEarn: zero owner"
        );

        address previous = owner;

        owner = newOwner;

        emit OwnershipTransferred(
            previous,
            newOwner
        );
    }

    // ------------------------------------------------------------
    // Create bounty
    // ------------------------------------------------------------

    function createBounty(
        uint256 reward,
        bytes32 targetH3,
        bytes32 requiredC2paIssuer,
        bytes32 campaignId,
        uint64 expiration
    )
        external
        returns (uint256 bountyId)
    {
        require(
            reward > 0,
            "ClickToEarn: zero reward"
        );

        require(
            expiration > block.timestamp,
            "ClickToEarn: invalid expiration"
        );

        require(
            NODL.transferFrom(
                msg.sender,
                address(this),
                reward
            ),
            "ClickToEarn: NODL transfer failed"
        );

        bountyId = nextBountyId++;

        bounties[bountyId] = Bounty({
            creator: msg.sender,
            reward: reward,
            targetH3: targetH3,
            requiredC2paIssuer: requiredC2paIssuer,
            campaignId: campaignId,
            expiration: expiration,
            status: BountyStatus.Active
        });

        emit BountyCreated(
            bountyId,
            msg.sender,
            reward,
            targetH3,
            requiredC2paIssuer,
            campaignId,
            expiration
        );
    }

    // ------------------------------------------------------------
    // Settle bounty
    // ------------------------------------------------------------

    function settleBounty(
        uint256 bountyId,
        address claimant,
        bytes32 proofHash,
        bytes32 evidenceId,
        bytes32 h3Index,
        bytes32 c2paIssuer
    )
        external
        onlyOracle
    {
        Bounty storage bounty = bounties[bountyId];

        require(
            bounty.status == BountyStatus.Active,
            "ClickToEarn: bounty inactive"
        );

        require(
            block.timestamp <= bounty.expiration,
            "ClickToEarn: bounty expired"
        );

        require(
            claimant != address(0),
            "ClickToEarn: zero claimant"
        );

        require(
            proofHash != bytes32(0),
            "ClickToEarn: zero proof"
        );

        require(
            evidenceId != bytes32(0),
            "ClickToEarn: zero evidence"
        );

        require(
            !usedProofs[proofHash],
            "ClickToEarn: proof already used"
        );

        require(
            !usedEvidence[evidenceId],
            "ClickToEarn: evidence already used"
        );

        require(
            h3Index == bounty.targetH3,
            "ClickToEarn: wrong H3"
        );

        require(
            c2paIssuer == bounty.requiredC2paIssuer,
            "ClickToEarn: wrong C2PA issuer"
        );

        // Mark everything consumed before transferring funds.
        bounty.status = BountyStatus.Settled;

        usedProofs[proofHash] = true;
        usedEvidence[evidenceId] = true;

        uint256 reward = bounty.reward;

        bounty.reward = 0;

        claims[bountyId] = Claim({
            claimant: claimant,
            bountyId: bountyId,
            proofHash: proofHash,
            evidenceId: evidenceId,
            timestamp: uint64(block.timestamp)
        });

        require(
            NODL.transfer(
                claimant,
                reward
            ),
            "ClickToEarn: payout failed"
        );

        emit BountySettled(
            bountyId,
            claimant,
            reward,
            proofHash,
            evidenceId
        );
    }

    // ------------------------------------------------------------
    // Expiration
    // ------------------------------------------------------------

    function reclaimExpiredBounty(
        uint256 bountyId
    )
        external
    {
        Bounty storage bounty = bounties[bountyId];

        require(
            bounty.status == BountyStatus.Active,
            "ClickToEarn: bounty inactive"
        );

        require(
            block.timestamp > bounty.expiration,
            "ClickToEarn: not expired"
        );

        require(
            msg.sender == bounty.creator,
            "ClickToEarn: not creator"
        );

        bounty.status = BountyStatus.Expired;

        uint256 refund = bounty.reward;

        bounty.reward = 0;

        require(
            NODL.transfer(
                bounty.creator,
                refund
            ),
            "ClickToEarn: refund failed"
        );

        emit BountyExpired(
            bountyId,
            bounty.creator,
            refund
        );
    }

    // ------------------------------------------------------------
    // Creator cancellation
    // ------------------------------------------------------------

    function cancelBounty(
        uint256 bountyId
    )
        external
    {
        Bounty storage bounty = bounties[bountyId];

        require(
            bounty.status == BountyStatus.Active,
            "ClickToEarn: bounty inactive"
        );

        require(
            msg.sender == bounty.creator,
            "ClickToEarn: not creator"
        );

        bounty.status = BountyStatus.Cancelled;

        uint256 refund = bounty.reward;

        bounty.reward = 0;

        require(
            NODL.transfer(
                bounty.creator,
                refund
            ),
            "ClickToEarn: refund failed"
        );

        emit BountyCancelled(
            bountyId,
            bounty.creator,
            refund
        );
    }

    // ------------------------------------------------------------
    // Views
    // ------------------------------------------------------------

    function getBounty(
        uint256 bountyId
    )
        external
        view
        returns (Bounty memory)
    {
        return bounties[bountyId];
   