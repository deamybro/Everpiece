// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The subset of Uniswap v4's PoolManager this adapter calls (v4-core IPoolManager; types ABI-identical:
///         Currency = address, IHooks = address, BalanceDelta = int256 packing amount0 (high 128) / amount1 (low 128)).
interface IV4PoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified; // < 0 exact input, > 0 exact output
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function take(address currency, address to, uint256 amount) external;
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
}

/// @title EverpieceStableConverter
/// @notice Permissionless AUSD ↔ USDC conversion through ONE fixed Uniswap v4 pool (the pool Kuru Flow routes this
///         pair through; docs/VERIFIED.md §4.19). Exact output: the recipient gets EXACTLY `amountOut` or the call
///         reverts; the input used is at most `maxIn` and the rest goes back to the caller.
/// @dev No owner, no admin, no stored funds, no external calldata: the pool key is immutable and the only external
///      contract called is the PoolManager (plus the two tokens). The caller funds the swap with its own tokens
///      (transferFrom msg.sender), so anyone may use it; it can never touch a third party's balance.
contract EverpieceStableConverter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint160 internal constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    IV4PoolManager public immutable POOL_MANAGER;
    address public immutable TOKEN0;
    address public immutable TOKEN1;
    uint24 public immutable FEE;
    int24 public immutable TICK_SPACING;

    /// @dev Set only for the duration of our own unlock, so unlockCallback can't be driven by anyone else.
    bool private _inSwap;

    event Converted(address indexed caller, address indexed tokenIn, address indexed recipient, uint256 amountIn, uint256 amountOut);

    error ZeroAddress();
    error UnsupportedPair();
    error NotPoolManager();
    error NotInSwap();
    error ZeroAmount();
    error ExcessiveInput(uint256 needed, uint256 maxIn);
    error PartialFill(uint256 delivered, uint256 wanted);
    error FundingMismatch();

    constructor(IV4PoolManager poolManager, address token0, address token1, uint24 fee, int24 tickSpacing) {
        if (address(poolManager) == address(0) || token0 == address(0) || token1 == address(0)) revert ZeroAddress();
        if (token0 >= token1) revert UnsupportedPair(); // v4 currency ordering
        POOL_MANAGER = poolManager;
        TOKEN0 = token0;
        TOKEN1 = token1;
        FEE = fee;
        TICK_SPACING = tickSpacing;
    }

    function supportsPair(address tokenIn, address tokenOut) public view returns (bool) {
        return (tokenIn == TOKEN0 && tokenOut == TOKEN1) || (tokenIn == TOKEN1 && tokenOut == TOKEN0);
    }

    function poolKey() public view returns (IV4PoolManager.PoolKey memory) {
        return IV4PoolManager.PoolKey(TOKEN0, TOKEN1, FEE, TICK_SPACING, address(0));
    }

    /// @notice Pull at most `maxIn` of `tokenIn` from the caller, deliver EXACTLY `amountOut` of `tokenOut` to
    ///         `recipient`, return the unused input to the caller.
    function convertExactOut(address tokenIn, address tokenOut, uint256 amountOut, uint256 maxIn, address recipient)
        external
        nonReentrant
        returns (uint256 amountIn)
    {
        if (!supportsPair(tokenIn, tokenOut)) revert UnsupportedPair();
        if (recipient == address(0)) revert ZeroAddress();
        if (amountOut == 0 || maxIn == 0) revert ZeroAmount();

        uint256 held = IERC20(tokenIn).balanceOf(address(this));
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), maxIn);
        if (IERC20(tokenIn).balanceOf(address(this)) != held + maxIn) revert FundingMismatch();

        uint256 outBefore = IERC20(tokenOut).balanceOf(recipient);
        _inSwap = true;
        bytes memory r = POOL_MANAGER.unlock(abi.encode(tokenIn, tokenOut, amountOut, maxIn, recipient));
        _inSwap = false;
        amountIn = abi.decode(r, (uint256));
        if (IERC20(tokenOut).balanceOf(recipient) != outBefore + amountOut) revert PartialFill(0, amountOut);

        uint256 left = IERC20(tokenIn).balanceOf(address(this)) - held;
        if (left != maxIn - amountIn) revert FundingMismatch();
        if (left > 0) IERC20(tokenIn).safeTransfer(msg.sender, left);
        emit Converted(msg.sender, tokenIn, recipient, amountIn, amountOut);
    }

    /// @dev v4 flash accounting: swap, take the output straight to the recipient, then pay the input in.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        if (!_inSwap) revert NotInSwap();
        (address tokenIn, address tokenOut, uint256 amountOut, uint256 maxIn, address recipient) =
            abi.decode(data, (address, address, uint256, uint256, address));

        bool zeroForOne = tokenIn == TOKEN0;
        int256 delta = POOL_MANAGER.swap(
            poolKey(),
            IV4PoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: int256(amountOut),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE
            }),
            ""
        );
        int128 a0 = int128(delta >> 128);
        int128 a1 = int128(delta);
        (int128 dIn, int128 dOut) = zeroForOne ? (a0, a1) : (a1, a0);
        // the pool may stop at the price limit: anything but the full output is refused
        if (dOut <= 0 || uint256(uint128(dOut)) != amountOut) revert PartialFill(dOut > 0 ? uint256(uint128(dOut)) : 0, amountOut);
        uint256 amountIn = uint256(uint128(-dIn));
        if (amountIn > maxIn) revert ExcessiveInput(amountIn, maxIn);

        POOL_MANAGER.take(tokenOut, recipient, amountOut);
        POOL_MANAGER.sync(tokenIn);
        IERC20(tokenIn).safeTransfer(address(POOL_MANAGER), amountIn);
        POOL_MANAGER.settle();
        return abi.encode(amountIn);
    }
}
