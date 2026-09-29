// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title MockAUSD
/// @notice Test double that mirrors the VERIFIED semantics of Monad AUSD (docs/VERIFIED.md -2.4-2.11):
///         EIP-712 domain "Agora Dollar"/"1", ERC-3009 receive with payee check and strict validity window,
///         per-authorizer bytes32 nonces, cancelAuthorization, freeze, issuer burn, transfer / signature pause,
///         the receiveWithAuthorization "upgraded" flag, and raw-ecrecover signature checks (accepts high-s).
///         Extra fault switches let tests simulate a misbehaving/upgraded token.
contract MockAUSD {
    string public constant name = "AUSD";
    string public constant symbol = "AUSD";
    uint8 public constant decimals = 6;

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

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isAccountFrozen;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    uint256 public totalSupply;

    // Issuer switches (exist on real AUSD)
    bool public isTransferPaused;
    bool public isSignatureVerificationPaused;
    bool private _receiveUpgraded;

    // Fault switches (test-only)
    bool public flagReadReverts;
    uint256 public fundingShortfall; // receive delivers value - fundingShortfall
    uint256 public payoutShortfall; // transfer moves amount - payoutShortfall (escrow balance drops by less than amount)
    bool public transferReturnsFalse;
    bool public transferReverts;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error TransferPaused();
    error SignatureVerificationPaused();
    error InvalidPayee(address caller, address payee);
    error InvalidAuthorization();
    error ExpiredAuthorization();
    error UsedOrCanceledAuthorization();
    error InvalidSignature();
    error AccountIsFrozen(address frozenAccount);
    error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);
    error ForcedRevert();

    // ---------------------------------------------------------------------------------------------
    // EIP-712
    // ---------------------------------------------------------------------------------------------

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Agora Dollar"), keccak256("1"), block.chainid, address(this)));
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    /// @dev Like Solady SignatureCheckerLib for EOAs: 64-byte (EIP-2098) or 65-byte, no low-s enforcement.
    function _isValid(address signer, bytes32 digest, bytes memory sig) internal pure returns (bool) {
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
        if (isTransferPaused) revert TransferPaused();
        if (isSignatureVerificationPaused) revert SignatureVerificationPaused();
        if (to != msg.sender && !_receiveUpgraded) revert InvalidPayee(msg.sender, to);
        _useAuthorization(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
        _move(from, to, value, value - fundingShortfall);
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
        if (isTransferPaused) revert TransferPaused();
        if (isSignatureVerificationPaused) revert SignatureVerificationPaused();
        _useAuthorization(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
        _move(from, to, value, value);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) external {
        if (authorizationState[authorizer][nonce]) revert UsedOrCanceledAuthorization();
        bytes32 digest = _digest(keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)));
        if (!_isValid(authorizer, digest, signature)) revert InvalidSignature();
        authorizationState[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
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
    ) internal {
        if (block.timestamp <= validAfter) revert InvalidAuthorization();
        if (block.timestamp >= validBefore) revert ExpiredAuthorization();
        if (authorizationState[from][nonce]) revert UsedOrCanceledAuthorization();
        bytes32 digest = _digest(keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce)));
        if (!_isValid(from, digest, signature)) revert InvalidSignature();
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }

    // ---------------------------------------------------------------------------------------------
    // ERC-20 subset
    // ---------------------------------------------------------------------------------------------

    function transfer(address to, uint256 amount) external returns (bool) {
        if (transferReverts) revert ForcedRevert();
        if (isTransferPaused) revert TransferPaused();
        if (transferReturnsFalse) return false;
        _move(msg.sender, to, amount - payoutShortfall, amount - payoutShortfall);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    /// @dev debit `debit` from `from`, credit `credit` to `to` (credit < debit models a fee/short delivery).
    function _move(address from, address to, uint256 debit, uint256 credit) internal {
        if (isAccountFrozen[from]) revert AccountIsFrozen(from);
        uint256 bal = balanceOf[from];
        if (bal < debit) revert ERC20InsufficientBalance(from, bal, debit);
        unchecked {
            balanceOf[from] = bal - debit;
        }
        if (isAccountFrozen[to]) revert AccountIsFrozen(to);
        balanceOf[to] += credit;
        totalSupply -= (debit - credit);
        emit Transfer(from, to, credit);
    }

    // ---------------------------------------------------------------------------------------------
    // Issuer + test controls
    // ---------------------------------------------------------------------------------------------

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @dev Real AUSD BURNER_ROLE can burn from any account without allowance (VERIFIED -2.11).
    function burn(address from, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
        return true;
    }

    function setFrozen(address account, bool frozen) external {
        isAccountFrozen[account] = frozen;
    }

    function setTransferPaused(bool v) external {
        isTransferPaused = v;
    }

    function setSignatureVerificationPaused(bool v) external {
        isSignatureVerificationPaused = v;
    }

    function setReceiveWithAuthorizationUpgraded(bool v) external {
        _receiveUpgraded = v;
    }

    /// @dev Real AUSD exposes this view (VERIFIED -2.10). Tests can make the read revert.
    function isReceiveWithAuthorizationUpgraded() external view returns (bool) {
        if (flagReadReverts) revert ForcedRevert();
        return _receiveUpgraded;
    }

    function setFlagReadReverts(bool v) external {
        flagReadReverts = v;
    }

    function setFundingShortfall(uint256 v) external {
        fundingShortfall = v;
    }

    function setPayoutShortfall(uint256 v) external {
        payoutShortfall = v;
    }

    function setTransferReturnsFalse(bool v) external {
        transferReturnsFalse = v;
    }

    function setTransferReverts(bool v) external {
        transferReverts = v;
    }
}
