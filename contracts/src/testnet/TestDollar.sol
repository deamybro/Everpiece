// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title TestDollar
/// @notice TESTNET-ONLY dollar for Everpiece on Monad testnet, where AUSD does not exist (docs/VERIFIED.md §4.9).
///         Worthless by design. It reproduces exactly the AUSD surface EverpieceEscrow relies on (IAUSD; VERIFIED
///         §2.4–2.11) so the unchanged escrow runs on testnet:
///         - ERC-3009 `receiveWithAuthorization` with the payee check (`to == msg.sender`) and the strict window
///           `validAfter < now < validBefore`; per-authorizer bytes32 nonces; `cancelAuthorization`;
///         - raw-ecrecover EOA signatures, 65-byte or 64-byte (EIP-2098), high-s accepted (as AUSD);
///         - `isReceiveWithAuthorizationUpgraded()` permanently false.
///         Unlike AUSD it has an honest name and EIP-712 domain ("Everpiece Test Dollar"), no freeze, burn or pause,
///         and minting only by the faucet's `minter`, capped per call.
/// @dev Never deploy to mainnet: the escrow on mainnet must be constructed with real AUSD.
contract TestDollar {
    string public constant name = "Everpiece Test Dollar";
    string public constant symbol = "tUSD";
    uint8 public constant decimals = 6;
    string public constant EIP712_NAME = "Everpiece Test Dollar";
    string public constant EIP712_VERSION = "1";

    /// @notice Most a single mint can create: $100 (one "Get 100 test Dollars").
    uint256 public constant MAX_MINT = 100e6;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    /// @notice The faucet service key; the only address that can mint.
    address public immutable minter;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    // Same custom errors as AUSD (IAUSD), so off-chain decoding is identical.
    error InvalidPayee(address caller, address payee);
    error InvalidAuthorization();
    error ExpiredAuthorization();
    error UsedOrCanceledAuthorization();
    error InvalidSignature();
    error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);
    error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed);
    error ERC20InvalidReceiver(address receiver);
    error NotMinter();
    error MintTooLarge(uint256 amount);

    constructor(address minter_) {
        if (minter_ == address(0)) revert ERC20InvalidReceiver(address(0));
        minter = minter_;
    }

    // ---------------------------------------------------------------------------------------------
    // EIP-712
    // ---------------------------------------------------------------------------------------------

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(EIP712_NAME)), keccak256(bytes(EIP712_VERSION)), block.chainid, address(this))
        );
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    /// @dev EOA-only, as AUSD for EOAs: 65-byte r‖s‖v or 64-byte EIP-2098; no low-s enforcement.
    function _isValid(address signer, bytes32 digest, bytes memory sig) private pure returns (bool) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        if (sig.length == 65) {
            assembly {
                r := mload(add(sig, 0x20))
                s := mload(add(sig, 0x40))
                v := byte(0, mload(add(sig, 0x60)))
            }
        } else if (sig.length == 64) {
            bytes32 vs;
            assembly {
                r := mload(add(sig, 0x20))
                vs := mload(add(sig, 0x40))
            }
            s = vs & bytes32(0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
            v = uint8((uint256(vs) >> 255) + 27);
        } else {
            return false;
        }
        address rec = ecrecover(digest, v, r, s);
        return rec != address(0) && rec == signer;
    }

    // ---------------------------------------------------------------------------------------------
    // ERC-3009
    // ---------------------------------------------------------------------------------------------

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        if (to != msg.sender) revert InvalidPayee(msg.sender, to);
        _useAuthorization(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
        _move(from, to, value);
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        _useAuthorization(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
        _move(from, to, value);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) external {
        if (authorizationState[authorizer][nonce]) revert UsedOrCanceledAuthorization();
        bytes32 digest = _digest(keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)));
        if (!_isValid(authorizer, digest, signature)) revert InvalidSignature();
        authorizationState[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    /// @notice Always false: this token's receive path never changes (AUSD exposes the same view, VERIFIED §2.10).
    function isReceiveWithAuthorizationUpgraded() external pure returns (bool) {
        return false;
    }

    function _useAuthorization(
        bytes32 typehash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) private {
        if (block.timestamp <= validAfter) revert InvalidAuthorization();
        if (block.timestamp >= validBefore) revert ExpiredAuthorization();
        if (authorizationState[from][nonce]) revert UsedOrCanceledAuthorization();
        bytes32 digest = _digest(keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce)));
        if (!_isValid(from, digest, signature)) revert InvalidSignature();
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }

    // ---------------------------------------------------------------------------------------------
    // ERC-20
    // ---------------------------------------------------------------------------------------------

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert ERC20InsufficientAllowance(msg.sender, allowed, amount);
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        if (to == address(0)) revert ERC20InvalidReceiver(address(0));
        uint256 bal = balanceOf[from];
        if (bal < amount) revert ERC20InsufficientBalance(from, bal, amount);
        unchecked {
            balanceOf[from] = bal - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Faucet
    // ---------------------------------------------------------------------------------------------

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        if (amount > MAX_MINT) revert MintTooLarge(amount);
        if (to == address(0)) revert ERC20InvalidReceiver(address(0));
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }
}
