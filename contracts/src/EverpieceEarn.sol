// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAUSD} from "./interfaces/IAUSD.sol";

/// @title EverpieceEarn
/// @notice Gasless deposits into and withdrawals from verified AUSD ERC-4626 vaults (mainnet: Aave V3 "Wrapped Aave
///         Monad AUSD"; docs/EARN.md). The owner only signs; a relayer submits. Shares are always minted to the owner
///         and assets always paid to the owner: this contract never holds anything between transactions.
/// @dev No owner, no admin, no upgrade path. The vault list is fixed at deployment and every vault must have AUSD as
///      its asset. Deposits: the AUSD ERC-3009 `receiveWithAuthorization` nonce IS the deposit id (EIP-712 digest of
///      every term), so a relayer can't change the vault, amount or minimum shares. Withdrawals: the owner signs the
///      withdrawal terms and an ERC-2612 permit on the vault's shares; the withdrawal id settles at most once.
contract EverpieceEarn is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Deposit {
        bytes32 ref; // the Automate leg / app action it belongs to
        address owner;
        address vault;
        uint256 assets; // AUSD in (6 decimals)
        uint256 minShares; // from previewDeposit at quote time
        uint256 deadline;
    }

    struct Withdrawal {
        bytes32 ref;
        address owner;
        address vault;
        uint256 assets; // AUSD out to the owner
        uint256 maxShares; // from previewWithdraw at quote time
        uint256 deadline;
    }

    bytes32 public constant DEPOSIT_TYPEHASH = keccak256(
        "Deposit(bytes32 ref,address owner,address vault,uint256 assets,uint256 minShares,uint256 deadline)"
    );
    bytes32 public constant WITHDRAWAL_TYPEHASH = keccak256(
        "Withdrawal(bytes32 ref,address owner,address vault,uint256 assets,uint256 maxShares,uint256 deadline)"
    );

    IAUSD public immutable AUSD;
    mapping(address vault => bool) public isVault;
    /// @notice Deposit / withdrawal id → executed.
    mapping(bytes32 id => bool) public settled;
    /// @notice AUSD the owner put into a vault through this contract, minus what they took back out (principal first).
    ///         A HARVEST withdrawal (ref starts with "HRV1") can never leave the position worth less than this: Earn →
    ///         Invest only ever spends earnings, enforced here rather than by any off-chain ledger.
    mapping(address owner => mapping(address vault => uint256)) public principalOf;
    bytes4 public constant HARVEST_TAG = 0x48525631; // "HRV1"

    event VaultEnabled(address indexed vault);
    event EarnDeposited(bytes32 indexed id, bytes32 indexed ref, address indexed owner, address vault, uint256 assets, uint256 shares);
    event EarnWithdrawn(bytes32 indexed id, bytes32 indexed ref, address indexed owner, address vault, uint256 assets, uint256 shares);

    error ZeroAddress();
    error InvalidVault();
    error DuplicateVault();
    error UnknownVault();
    error ZeroAmount();
    error Expired();
    error AlreadySettled();
    error InvalidOwnerSignature();
    error FundingMismatch();
    error SlippageExceeded();
    error SettlementMismatch();
    error AusdSemanticsChanged();
    error PrincipalProtected();

    constructor(IAUSD ausd, address[] memory vaults) EIP712("Everpiece Earn", "1") {
        if (address(ausd) == address(0)) revert ZeroAddress();
        AUSD = ausd;
        for (uint256 i; i < vaults.length; ++i) {
            address v = vaults[i];
            if (v == address(0) || v.code.length == 0) revert InvalidVault();
            if (IERC4626(v).asset() != address(ausd)) revert InvalidVault();
            if (isVault[v]) revert DuplicateVault();
            isVault[v] = true;
            emit VaultEnabled(v);
        }
    }

    // ---------------------------------------------------------------------------------------------

    /// @notice Pull `assets` AUSD from the owner (one ERC-3009 signature whose nonce is the deposit id) and deposit them
    ///         into the vault for the owner. Reverts unless at least `minShares` shares reach the owner.
    function deposit(Deposit calldata d, bytes calldata ausdSignature) external nonReentrant returns (bytes32 id, uint256 shares) {
        if (d.owner == address(0)) revert ZeroAddress();
        if (!isVault[d.vault]) revert UnknownVault();
        if (d.assets == 0) revert ZeroAmount();
        if (block.timestamp >= d.deadline) revert Expired();
        id = depositIdOf(d);
        if (settled[id]) revert AlreadySettled();
        settled[id] = true;
        _requireVerifiedAusdReceiveSemantics();

        uint256 before = AUSD.balanceOf(address(this));
        AUSD.receiveWithAuthorization(d.owner, address(this), d.assets, 0, d.deadline, id, ausdSignature);
        if (AUSD.balanceOf(address(this)) != before + d.assets) revert FundingMismatch();

        uint256 sharesBefore = IERC20(d.vault).balanceOf(d.owner);
        IERC20(address(AUSD)).forceApprove(d.vault, d.assets);
        shares = IERC4626(d.vault).deposit(d.assets, d.owner);
        IERC20(address(AUSD)).forceApprove(d.vault, 0);
        if (shares < d.minShares) revert SlippageExceeded();
        if (IERC20(d.vault).balanceOf(d.owner) != sharesBefore + shares) revert SettlementMismatch();
        if (AUSD.balanceOf(address(this)) != before) revert SettlementMismatch(); // nothing left behind
        principalOf[d.owner][d.vault] += d.assets;
        emit EarnDeposited(id, d.ref, d.owner, d.vault, d.assets, shares);
    }

    /// @notice Withdraw `assets` AUSD from the vault to the owner, burning at most `maxShares` of the owner's shares.
    ///         `ownerSignature` signs the Withdrawal; the share permit (for `maxShares`, same deadline) lets this
    ///         contract burn them. If someone front-runs the permit, an existing allowance is used instead.
    function withdraw(Withdrawal calldata w, bytes calldata ownerSignature, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        returns (bytes32 id, uint256 shares)
    {
        if (w.owner == address(0)) revert ZeroAddress();
        if (!isVault[w.vault]) revert UnknownVault();
        if (w.assets == 0 || w.maxShares == 0) revert ZeroAmount();
        if (block.timestamp >= w.deadline) revert Expired();
        id = withdrawalIdOf(w);
        if (settled[id]) revert AlreadySettled();
        if (!SignatureChecker.isValidSignatureNow(w.owner, id, ownerSignature)) revert InvalidOwnerSignature();
        settled[id] = true;

        try IERC20Permit(w.vault).permit(w.owner, address(this), w.maxShares, w.deadline, v, r, s) {} catch {}

        uint256 assetsBefore = AUSD.balanceOf(w.owner);
        shares = IERC4626(w.vault).withdraw(w.assets, w.owner, w.owner);
        if (shares > w.maxShares) revert SlippageExceeded();
        if (AUSD.balanceOf(w.owner) != assetsBefore + w.assets) revert SettlementMismatch();
        uint256 p = principalOf[w.owner][w.vault];
        if (bytes4(w.ref) == HARVEST_TAG) {
            // earnings only: what stays in the vault must still be worth at least the principal
            if (IERC4626(w.vault).convertToAssets(IERC20(w.vault).balanceOf(w.owner)) < p) revert PrincipalProtected();
        } else {
            // an owner withdrawal takes principal first (docs/EARN.md §accounting)
            principalOf[w.owner][w.vault] = p > w.assets ? p - w.assets : 0;
        }
        emit EarnWithdrawn(id, w.ref, w.owner, w.vault, w.assets, shares);
    }

    // ---------------------------------------------------------------------------------------------

    function depositIdOf(Deposit calldata d) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(DEPOSIT_TYPEHASH, d.ref, d.owner, d.vault, d.assets, d.minShares, d.deadline)));
    }

    function withdrawalIdOf(Withdrawal calldata w) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(WITHDRAWAL_TYPEHASH, w.ref, w.owner, w.vault, w.assets, w.maxShares, w.deadline)));
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @dev Same fail-closed check as EverpiecePay: AUSD's payee-checked receive must not have been re-routed.
    ///      Virtual only so EverpieceEarnUsdc can drop this AUSD-only read.
    function _requireVerifiedAusdReceiveSemantics() internal view virtual {
        try AUSD.isReceiveWithAuthorizationUpgraded() returns (bool upgraded) {
            if (upgraded) revert AusdSemanticsChanged();
        } catch {
            revert AusdSemanticsChanged();
        }
    }
}
