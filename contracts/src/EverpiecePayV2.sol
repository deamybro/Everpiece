// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAUSD} from "./interfaces/IAUSD.sol";
import {IAgoraStableSwapPair} from "./interfaces/IAgoraStableSwapPair.sol";

/// @notice The ERC-3009 receive both Monad AUSD and Monad USDC implement (packed r‖s‖v overload, payee-checked:
///         reverts unless `to == msg.sender`). USDC: contracts/test/fork/UsdcProbe.t.sol; AUSD: AusdProbe.t.sol.
interface IERC3009Receive {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

/// @notice EverpieceStableConverter (fixed Uniswap v4 pool, exact output).
interface IStableConverter {
    function supportsPair(address tokenIn, address tokenOut) external view returns (bool);
    function convertExactOut(address tokenIn, address tokenOut, uint256 amountOut, uint256 maxIn, address recipient)
        external
        returns (uint256 amountIn);
}

/// @title EverpiecePayV2
/// @notice Instant multi-asset payments (mainnet mandate: USDC and AUSD are both first-class). The recipient receives
///         EXACTLY `amount` of the `asset` the payment names, final at once. The payer funds it either
///         - DIRECT: in the same asset (USDC → USDC, AUSD → AUSD), no conversion, no third party; or
///         - CONVERTED: in the other asset. Providers, in order: (1) the Agora Instant Settlement pair, only while
///           Agora has granted this contract APPROVED_SWAPPER; (2) the fixed EverpieceStableConverter (permissionless
///           Uniswap v4 pool). Both are exact-output swaps straight to the recipient; unused input returns to the payer.
///           If neither can deliver: with `fallbackToSource` the recipient receives `amount` of the SOURCE asset
///           instead (event says so: `deliveredAsset` = source, never the requested asset); without it the whole
///           payment reverts and nothing moves.
/// @dev Gasless: a relayer submits, the payer signs ONE ERC-3009 ReceiveWithAuthorization in the source token's own
///      domain whose nonce is the payment id (EIP-712 digest of every term), so nothing can be changed or replayed.
///      No owner, no admin, no upgrade path, no arbitrary calls: assets, pairs and the converter are fixed at
///      deployment. A relayer can't starve a conversion into the fallback: each attempt requires a gas floor.
contract EverpiecePayV2 is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice A settlement asset and whether it carries AUSD's upgrade flag (checked fail-closed before each pull).
    struct Asset {
        address token;
        bool ausdSemantics;
    }

    /// @notice What the payer agrees to.
    /// @dev DIRECT when sourceToken == asset (then maxSourceAmount must equal amount).
    struct Payment {
        bytes32 ref;
        address sender;
        address recipient;
        address asset; // what the recipient asked for
        uint256 amount; // exact, in `asset` base units (all assets have 6 decimals)
        address sourceToken; // what the payer spends
        uint256 maxSourceAmount; // the most of sourceToken the payer allows (from the quote)
        uint256 deadline;
        bool fallbackToSource; // if conversion is unavailable, deliver `amount` of sourceToken instead of reverting
    }

    bytes32 public constant PAYMENT_TYPEHASH = keccak256(
        "Payment(bytes32 ref,address sender,address recipient,address asset,uint256 amount,address sourceToken,uint256 maxSourceAmount,uint256 deadline,bool fallbackToSource)"
    );

    /// @notice Gas that must remain before each conversion attempt (well above the measured worst case), so a
    ///         failed attempt reflects the route, not a relayer-chosen gas limit.
    uint256 public constant MIN_GAS_AGORA = 250_000;
    uint256 public constant MIN_GAS_CONVERTER = 400_000;

    /// @notice 0 = not an asset, 1 = asset, 2 = asset with AUSD semantics.
    mapping(address token => uint8) public assetKind;
    /// @notice sourceToken → asset → the Agora pair that converts between them (both directions registered).
    mapping(address source => mapping(address asset => address pair)) public pairFor;
    /// @notice The permissionless converter (address(0) = none).
    IStableConverter public immutable CONVERTER;
    /// @notice Payment id → settled. A signed payment executes once.
    mapping(bytes32 paymentId => bool) public settled;

    event AssetEnabled(address indexed token, bool ausdSemantics);
    event PairEnabled(address indexed tokenA, address indexed tokenB, address indexed pair);
    /// @param deliveredAsset what the recipient actually received (== the requested asset unless a fallback happened)
    /// @param provider address(0) direct / fallback, else the Agora pair or the converter that delivered
    event Paid(
        bytes32 indexed paymentId,
        bytes32 indexed ref,
        address indexed sender,
        address recipient,
        address deliveredAsset,
        uint256 amount,
        address sourceToken,
        uint256 sourceAmount,
        address provider
    );
    event ConversionFallback(bytes32 indexed paymentId, address requestedAsset, address deliveredAsset);

    error ZeroAddress();
    error DuplicateAsset();
    error InvalidPair();
    error DuplicatePair();
    error InvalidConverter();
    error InvalidRecipient();
    error ZeroAmount();
    error Expired();
    error AlreadySettled();
    error UnsupportedAsset();
    error UnsupportedRoute();
    error DirectAmountMismatch();
    error FallbackExceedsMax();
    error ConversionUnavailable();
    error InsufficientGas();
    error FundingMismatch();
    error SettlementMismatch();
    error AusdSemanticsChanged();

    constructor(Asset[] memory assets, address[] memory pairs, IStableConverter converter) EIP712("Everpiece Pay", "2") {
        for (uint256 i = 0; i < assets.length; i++) {
            address t = assets[i].token;
            if (t == address(0)) revert ZeroAddress();
            if (assetKind[t] != 0) revert DuplicateAsset();
            assetKind[t] = assets[i].ausdSemantics ? 2 : 1;
            emit AssetEnabled(t, assets[i].ausdSemantics);
        }
        for (uint256 i = 0; i < pairs.length; i++) {
            IAgoraStableSwapPair pair = IAgoraStableSwapPair(pairs[i]);
            address t0 = pair.token0();
            address t1 = pair.token1();
            if (t0 == t1 || assetKind[t0] == 0 || assetKind[t1] == 0) revert InvalidPair();
            if (pairFor[t0][t1] != address(0)) revert DuplicatePair();
            pairFor[t0][t1] = pairs[i];
            pairFor[t1][t0] = pairs[i];
            emit PairEnabled(t0, t1, pairs[i]);
        }
        if (address(converter) != address(0) && address(converter).code.length == 0) revert InvalidConverter();
        CONVERTER = converter;
    }

    /// @notice Settle a signed payment. `signature` is the sender's ERC-3009 ReceiveWithAuthorization in the
    ///         `sourceToken` domain: from = sender, to = this, value = maxSourceAmount, validAfter = 0,
    ///         validBefore = deadline, nonce = paymentIdOf(p).
    function pay(Payment calldata p, bytes calldata signature) external nonReentrant returns (bytes32 paymentId) {
        if (assetKind[p.asset] == 0) revert UnsupportedAsset();
        if (assetKind[p.sourceToken] == 0) revert UnsupportedRoute();
        bool direct = p.sourceToken == p.asset;
        if (direct) {
            if (p.maxSourceAmount != p.amount) revert DirectAmountMismatch();
        } else {
            if (!p.fallbackToSource && pairFor[p.sourceToken][p.asset] == address(0) && !_converterSupports(p)) {
                revert UnsupportedRoute();
            }
            if (p.fallbackToSource && p.amount > p.maxSourceAmount) revert FallbackExceedsMax();
        }
        paymentId = _open(p);

        IERC20 source = IERC20(p.sourceToken);
        _requireVerifiedReceive(p.sourceToken);
        uint256 heldBefore = source.balanceOf(address(this));
        IERC3009Receive(p.sourceToken).receiveWithAuthorization(
            p.sender, address(this), p.maxSourceAmount, 0, p.deadline, paymentId, signature
        );
        if (source.balanceOf(address(this)) != heldBefore + p.maxSourceAmount) revert FundingMismatch();

        address delivered = p.asset;
        address provider;
        uint256 recipientBefore = IERC20(p.asset).balanceOf(p.recipient);
        if (direct) {
            IERC20(p.asset).safeTransfer(p.recipient, p.amount);
        } else {
            provider = _tryAgora(p);
            if (provider == address(0)) provider = _tryConverter(p);
            if (provider == address(0)) {
                if (!p.fallbackToSource) revert ConversionUnavailable();
                // Keep the payer's USDC (or AUSD) as what it is: the recipient gets `amount` of the source asset.
                delivered = p.sourceToken;
                recipientBefore = source.balanceOf(p.recipient);
                source.safeTransfer(p.recipient, p.amount);
                emit ConversionFallback(paymentId, p.asset, delivered);
            }
        }
        if (IERC20(delivered).balanceOf(p.recipient) != recipientBefore + p.amount) revert SettlementMismatch();

        // Return what wasn't used; this contract keeps nothing.
        uint256 left = source.balanceOf(address(this)) - heldBefore;
        uint256 spent = p.maxSourceAmount - left;
        if (left > 0) source.safeTransfer(p.sender, left);
        if (source.balanceOf(address(this)) != heldBefore) revert SettlementMismatch();
        emit Paid(paymentId, p.ref, p.sender, p.recipient, delivered, p.amount, p.sourceToken, spent, provider);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function paymentIdOf(Payment calldata p) external view returns (bytes32) {
        return _id(p);
    }

    /// @notice Agora route: can `sourceToken` pay exactly `amount` of `asset` through the Agora pair right now, and for
    ///         how much? Never reverts. (The converter route is quoted off-chain with Uniswap's v4 Quoter.)
    function quote(address sourceToken, address asset, uint256 amount)
        external
        view
        returns (bool available, uint256 sourceAmount, address pair)
    {
        if (assetKind[asset] == 0 || assetKind[sourceToken] == 0 || amount == 0) return (false, 0, address(0));
        if (sourceToken == asset) return (true, amount, address(0));
        pair = pairFor[sourceToken][asset];
        if (pair == address(0) || !_agoraApproved(pair)) return (false, 0, pair);
        address[] memory path = new address[](2);
        path[0] = sourceToken;
        path[1] = asset;
        try IAgoraStableSwapPair(pair).getAmountsIn(amount, path) returns (uint256[] memory a) {
            if (a.length != 2 || a[0] == 0) return (false, 0, pair);
            return (true, a[0], pair);
        } catch {
            return (false, 0, pair);
        }
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    /// @dev Agora first, only when approved. A failed swap is rolled back by the EVM; the approval is reset.
    function _tryAgora(Payment calldata p) private returns (address) {
        address pair = pairFor[p.sourceToken][p.asset];
        if (pair == address(0) || !_agoraApproved(pair)) return address(0);
        if (gasleft() < MIN_GAS_AGORA) revert InsufficientGas();
        address[] memory path = new address[](2);
        path[0] = p.sourceToken;
        path[1] = p.asset;
        IERC20(p.sourceToken).forceApprove(pair, p.maxSourceAmount);
        bool ok;
        try IAgoraStableSwapPair(pair).swapTokensForExactTokens(p.amount, p.maxSourceAmount, path, p.recipient, p.deadline)
        returns (uint256[] memory) {
            ok = true;
        } catch {}
        IERC20(p.sourceToken).forceApprove(pair, 0);
        return ok ? pair : address(0);
    }

    function _tryConverter(Payment calldata p) private returns (address) {
        if (!_converterSupports(p)) return address(0);
        if (gasleft() < MIN_GAS_CONVERTER) revert InsufficientGas();
        IERC20(p.sourceToken).forceApprove(address(CONVERTER), p.maxSourceAmount);
        bool ok;
        try CONVERTER.convertExactOut(p.sourceToken, p.asset, p.amount, p.maxSourceAmount, p.recipient) returns (uint256) {
            ok = true;
        } catch {}
        IERC20(p.sourceToken).forceApprove(address(CONVERTER), 0);
        return ok ? address(CONVERTER) : address(0);
    }

    function _converterSupports(Payment calldata p) private view returns (bool) {
        return address(CONVERTER) != address(0) && CONVERTER.supportsPair(p.sourceToken, p.asset);
    }

    function _agoraApproved(address pair) private view returns (bool) {
        try IAgoraStableSwapPair(pair).hasRole("APPROVED_SWAPPER", address(this)) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _id(Payment calldata p) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PAYMENT_TYPEHASH,
                    p.ref,
                    p.sender,
                    p.recipient,
                    p.asset,
                    p.amount,
                    p.sourceToken,
                    p.maxSourceAmount,
                    p.deadline,
                    p.fallbackToSource
                )
            )
        );
    }

    /// @dev Shared checks, then mark the payment settled (effects before interactions).
    function _open(Payment calldata p) private returns (bytes32 paymentId) {
        if (p.sender == address(0)) revert ZeroAddress();
        if (p.recipient == address(0) || p.recipient == address(this)) revert InvalidRecipient();
        if (p.amount == 0) revert ZeroAmount();
        if (block.timestamp >= p.deadline) revert Expired();
        paymentId = _id(p);
        if (settled[paymentId]) revert AlreadySettled();
        settled[paymentId] = true;
    }

    /// @dev AUSD: fail closed if Agora re-routed its payee-checked receive (same check as EverpieceEscrow). Assets
    ///      without that flag (USDC) rely on the balance checks around every pull and transfer.
    function _requireVerifiedReceive(address token) private view {
        if (assetKind[token] != 2) return;
        try IAUSD(token).isReceiveWithAuthorizationUpgraded() returns (bool upgraded) {
            if (upgraded) revert AusdSemanticsChanged();
        } catch {
            revert AusdSemanticsChanged();
        }
    }
}
