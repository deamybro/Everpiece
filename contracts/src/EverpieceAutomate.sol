// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title EverpieceAutomate
/// @notice Bounded automation (docs/AUTOMATE.md §5 BOUNDED_MODULE): the owner signs ONE grant that lets one named
///         executor move the owner's USDC/AUSD into ONE allow-listed Earn vault, in the owner's own name, within
///         signed caps (per execution, per UTC day, in total) until an expiry. Nothing else is possible: no other
///         destination, no withdrawal, no transfer to anyone, no admin, no upgrade, no arbitrary call.
/// @dev Funding uses an ERC-2612 allowance from the owner to this contract, set by the permit submitted with the
///      grant (value = the grant's total). Every execution:
///        - pulls exactly `assets` from the owner (transferFrom),
///        - deposits them into the grant's vault with receiver = owner (shares never touch this contract),
///        - checks the owner's share balance rose by at least `minShares`,
///        - records the principal it added (`principalOf`), so "yield only" logic never mistakes it for earnings,
///        - is idempotent by `executionId`.
///      Revocation: `revoke` (owner, on-chain) or `revokeBySig` (gasless). An expired or revoked grant can't run.
contract EverpieceAutomate is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Grant {
        bytes32 ruleId; // the signed Automate rule this grant serves (docs/AUTOMATE.md)
        address owner;
        address executor; // the only address that may execute (the Everpiece relayer)
        address vault; // allow-listed ERC-4626 Earn vault; its asset() is what moves
        uint256 maxPerExecution;
        uint256 maxPerDay;
        uint256 total;
        uint256 expiresAt;
    }

    bytes32 public constant GRANT_TYPEHASH = keccak256(
        "Grant(bytes32 ruleId,address owner,address executor,address vault,uint256 maxPerExecution,uint256 maxPerDay,uint256 total,uint256 expiresAt)"
    );
    bytes32 public constant REVOKE_TYPEHASH = keccak256("Revoke(bytes32 grantId)");
    /// @notice Longest grant accepted (366 days, same as an Automate rule's expiry bound).
    uint256 public constant MAX_GRANT_DURATION = 366 days;

    struct GrantState {
        address owner;
        address executor;
        address vault;
        uint256 maxPerExecution;
        uint256 maxPerDay;
        uint256 total;
        uint256 expiresAt;
        uint256 spent;
        bool revoked;
    }

    mapping(address vault => address asset) public vaultAsset;
    mapping(bytes32 grantId => GrantState) public grants;
    mapping(bytes32 grantId => mapping(uint256 day => uint256)) public spentOnDay;
    mapping(bytes32 executionId => bool) public executed;
    /// @notice Principal this contract put into `vault` for `owner` (Earn's own principal ledger is EverpieceEarn's).
    mapping(address owner => mapping(address vault => uint256)) public principalOf;

    event VaultAllowed(address indexed vault, address indexed asset);
    event GrantActivated(bytes32 indexed grantId, bytes32 indexed ruleId, address indexed owner, address executor, address vault, uint256 total, uint256 expiresAt);
    event GrantRevoked(bytes32 indexed grantId, address indexed owner);
    event Executed(bytes32 indexed grantId, bytes32 indexed executionId, address indexed owner, address vault, uint256 assets, uint256 shares);

    error ZeroAddress();
    error InvalidVault();
    error DuplicateVault();
    error UnknownVault();
    error InvalidGrant();
    error InvalidSignature();
    error AlreadyActive();
    error UnknownGrant();
    error NotExecutor();
    error NotOwner();
    error Revoked();
    error GrantExpired();
    error AlreadyExecuted();
    error AboveExecutionCap();
    error AboveDailyCap();
    error AboveTotal();
    error ZeroAmount();
    error FundingMismatch();
    error SharesMismatch();

    constructor(address[] memory vaults) EIP712("Everpiece Automate", "1") {
        for (uint256 i = 0; i < vaults.length; i++) {
            address v = vaults[i];
            if (v == address(0)) revert ZeroAddress();
            address asset = IERC4626(v).asset();
            if (asset == address(0)) revert InvalidVault();
            if (vaultAsset[v] != address(0)) revert DuplicateVault();
            vaultAsset[v] = asset;
            emit VaultAllowed(v, asset);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Grant lifecycle
    // ---------------------------------------------------------------------------------------------

    /// @notice Activate a signed grant. Anyone may submit it (gasless): only the owner's signature counts.
    /// @param permitDeadline,v,r,s the owner's ERC-2612 permit for this contract over the vault's asset, value = total.
    ///        If someone already submitted it (front-running), the existing allowance is used.
    function activate(Grant calldata g, bytes calldata ownerSignature, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        returns (bytes32 grantId)
    {
        if (g.owner == address(0) || g.executor == address(0)) revert ZeroAddress();
        address asset = vaultAsset[g.vault];
        if (asset == address(0)) revert UnknownVault();
        if (
            g.maxPerExecution == 0 || g.maxPerExecution > g.maxPerDay || g.maxPerDay > g.total
                || g.expiresAt <= block.timestamp || g.expiresAt > block.timestamp + MAX_GRANT_DURATION
        ) revert InvalidGrant();
        grantId = grantIdOf(g);
        if (grants[grantId].owner != address(0)) revert AlreadyActive();
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(grantId, ownerSignature);
        if (err != ECDSA.RecoverError.NoError || signer != g.owner) revert InvalidSignature();

        grants[grantId] = GrantState({
            owner: g.owner,
            executor: g.executor,
            vault: g.vault,
            maxPerExecution: g.maxPerExecution,
            maxPerDay: g.maxPerDay,
            total: g.total,
            expiresAt: g.expiresAt,
            spent: 0,
            revoked: false
        });
        try IERC20Permit(asset).permit(g.owner, address(this), g.total, permitDeadline, v, r, s) {} catch {}
        emit GrantActivated(grantId, g.ruleId, g.owner, g.executor, g.vault, g.total, g.expiresAt);
    }

    function revoke(bytes32 grantId) external {
        GrantState storage st = grants[grantId];
        if (st.owner == address(0)) revert UnknownGrant();
        if (msg.sender != st.owner) revert NotOwner();
        _revoke(grantId, st);
    }

    /// @notice Gasless revocation: the owner's EIP-712 signature over Revoke(grantId).
    function revokeBySig(bytes32 grantId, bytes calldata ownerSignature) external {
        GrantState storage st = grants[grantId];
        if (st.owner == address(0)) revert UnknownGrant();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(REVOKE_TYPEHASH, grantId)));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, ownerSignature);
        if (err != ECDSA.RecoverError.NoError || signer != st.owner) revert InvalidSignature();
        _revoke(grantId, st);
    }

    function _revoke(bytes32 grantId, GrantState storage st) private {
        if (st.revoked) return;
        st.revoked = true;
        emit GrantRevoked(grantId, st.owner);
    }

    // ---------------------------------------------------------------------------------------------
    // Execution
    // ---------------------------------------------------------------------------------------------

    /// @notice Move `assets` of the owner's balance into the grant's vault, in the owner's name.
    /// @param executionId the Automate idempotency key (docs/AUTOMATE.md §4); each runs at most once
    /// @param minShares from previewDeposit at plan time (slippage bound on the vault's share price)
    function execute(bytes32 grantId, bytes32 executionId, uint256 assets, uint256 minShares)
        external
        nonReentrant
        returns (uint256 shares)
    {
        GrantState storage st = grants[grantId];
        if (st.owner == address(0)) revert UnknownGrant();
        if (msg.sender != st.executor) revert NotExecutor();
        if (st.revoked) revert Revoked();
        if (block.timestamp >= st.expiresAt) revert GrantExpired();
        if (assets == 0) revert ZeroAmount();
        if (executed[executionId]) revert AlreadyExecuted();
        if (assets > st.maxPerExecution) revert AboveExecutionCap();
        uint256 day = block.timestamp / 1 days;
        uint256 today = spentOnDay[grantId][day] + assets;
        if (today > st.maxPerDay) revert AboveDailyCap();
        if (st.spent + assets > st.total) revert AboveTotal();

        executed[executionId] = true;
        spentOnDay[grantId][day] = today;
        st.spent += assets;
        principalOf[st.owner][st.vault] += assets;

        IERC20 asset = IERC20(vaultAsset[st.vault]);
        uint256 held = asset.balanceOf(address(this));
        asset.safeTransferFrom(st.owner, address(this), assets);
        if (asset.balanceOf(address(this)) != held + assets) revert FundingMismatch();

        uint256 sharesBefore = IERC20(st.vault).balanceOf(st.owner);
        asset.forceApprove(st.vault, assets);
        shares = IERC4626(st.vault).deposit(assets, st.owner);
        asset.forceApprove(st.vault, 0);
        if (shares < minShares || IERC20(st.vault).balanceOf(st.owner) != sharesBefore + shares) revert SharesMismatch();
        if (asset.balanceOf(address(this)) != held) revert FundingMismatch(); // nothing left behind
        emit Executed(grantId, executionId, st.owner, st.vault, assets, shares);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function grantIdOf(Grant calldata g) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    GRANT_TYPEHASH, g.ruleId, g.owner, g.executor, g.vault, g.maxPerExecution, g.maxPerDay, g.total, g.expiresAt
                )
            )
        );
    }

    /// @notice How much the executor could still move right now under this grant (0 if it can't run).
    function remaining(bytes32 grantId) external view returns (uint256) {
        GrantState storage st = grants[grantId];
        if (st.owner == address(0) || st.revoked || block.timestamp >= st.expiresAt) return 0;
        uint256 dayLeft = st.maxPerDay - spentOnDay[grantId][block.timestamp / 1 days];
        uint256 totalLeft = st.total - st.spent;
        uint256 m = dayLeft < totalLeft ? dayLeft : totalLeft;
        return m < st.maxPerExecution ? m : st.maxPerExecution;
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
