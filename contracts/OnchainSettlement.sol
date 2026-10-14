// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title OnchainSettlement
/// @notice Escrowed limit-order settlement for ERC-20 pairs.
///
/// Makers post a signed-by-transaction limit order and deposit the offered
/// token into escrow. Takers pull liquidity by filling an order id, either
/// fully or partially. The contract enforces the maker's price ratio, routes
/// the protocol fee and protects user funds with `ReentrancyGuard` + `SafeERC20`.
///
/// This contract is the on-chain settlement leg that pairs with an off-chain
/// matching engine: the engine decides *who* trades with whom, this contract
/// guarantees *how* the assets move when the fill is executed.
contract OnchainSettlement is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Fee is expressed in basis points. 10_000 bps = 100%.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @dev Hard cap on the protocol fee: 100 bps = 1%.
    uint256 public constant MAX_FEE_BPS = 100;

    struct Order {
        uint256 id;
        address maker;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 buyAmount;
        uint256 filledSell;
        uint256 filledBuy;
        uint64 expiry;
        bool cancelled;
    }

    /// @notice Id that will be assigned to the next created order.
    uint256 public nextOrderId = 1;

    /// @notice Protocol fee, in basis points of the buy token paid by the taker.
    uint256 public feeBps;

    /// @notice Address that can withdraw accrued fees.
    address public feeRecipient;

    mapping(uint256 => Order) private _orders;
    mapping(address => uint256[]) private _makerOrderIds;

    /// @notice Fees accrued per token, claimable by `feeRecipient`.
    mapping(address => uint256) public accruedFees;

    event OrderCreated(
        uint256 indexed orderId,
        address indexed maker,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 buyAmount,
        uint64 expiry
    );

    event OrderFilled(
        uint256 indexed orderId,
        address indexed taker,
        uint256 sellFill,
        uint256 buyFill,
        uint256 fee
    );

    event OrderCancelled(uint256 indexed orderId, address indexed maker, uint256 refunded);

    event FeeBpsUpdated(uint256 previousFeeBps, uint256 newFeeBps);

    event FeeRecipientUpdated(address previousRecipient, address newRecipient);

    event FeesWithdrawn(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error IdenticalTokens();
    error ZeroAmount();
    error ExpiryInPast();
    error UnknownOrder();
    error OrderCancelledError();
    error OrderExpired();
    error OrderFullyFilled();
    error NotMaker();
    error SelfFill();
    error InvalidFillAmount();
    error FillTooSmall();
    error FeeTooHigh();
    error NothingToWithdraw();
    error NotAuthorized();

    /// @param initialOwner Address that administers fee configuration.
    /// @param initialFeeBps Initial protocol fee in basis points (max 100).
    /// @param initialFeeRecipient Address allowed to withdraw accrued fees.
    constructor(address initialOwner, uint256 initialFeeBps, address initialFeeRecipient)
        Ownable(initialOwner)
    {
        if (initialFeeRecipient == address(0)) revert ZeroAddress();
        if (initialFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = initialFeeBps;
        feeRecipient = initialFeeRecipient;
    }

    // ---------------------------------------------------------------------
    // Maker side
    // ---------------------------------------------------------------------

    /// @notice Escrows `sellAmount` of `sellToken` and publishes a limit order.
    /// @dev The maker's price is fully described by the `sellAmount` / `buyAmount` ratio.
    /// @param sellToken Token the maker offers (deposited into escrow).
    /// @param buyToken Token the maker wants in return.
    /// @param sellAmount Total amount of `sellToken` offered.
    /// @param buyAmount Total amount of `buyToken` requested.
    /// @param expiry Unix timestamp after which the order can no longer be filled. 0 = never expires.
    /// @return orderId Identifier of the created order.
    function createOrder(
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 buyAmount,
        uint64 expiry
    ) external nonReentrant returns (uint256 orderId) {
        if (sellToken == address(0) || buyToken == address(0)) revert ZeroAddress();
        if (sellToken == buyToken) revert IdenticalTokens();
        if (sellAmount == 0 || buyAmount == 0) revert ZeroAmount();
        if (expiry != 0 && expiry <= block.timestamp) revert ExpiryInPast();

        orderId = nextOrderId++;

        _orders[orderId] = Order({
            id: orderId,
            maker: msg.sender,
            sellToken: sellToken,
            buyToken: buyToken,
            sellAmount: sellAmount,
            buyAmount: buyAmount,
            filledSell: 0,
            filledBuy: 0,
            expiry: expiry,
            cancelled: false
        });

        _makerOrderIds[msg.sender].push(orderId);

        // Escrow the offered token. Requires the maker to have approved this contract.
        IERC20(sellToken).safeTransferFrom(msg.sender, address(this), sellAmount);

        emit OrderCreated(orderId, msg.sender, sellToken, buyToken, sellAmount, buyAmount, expiry);
    }

    /// @notice Cancels an order and refunds the unfilled escrow to the maker.
    /// @dev A fully filled order has nothing left to refund, so it can no longer be cancelled.
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = _orders[orderId];
        if (order.maker == address(0)) revert UnknownOrder();
        if (order.maker != msg.sender) revert NotMaker();
        if (order.cancelled) revert OrderCancelledError();

        uint256 refund = order.sellAmount - order.filledSell;
        if (refund == 0) revert OrderFullyFilled();

        order.cancelled = true;
        IERC20(order.sellToken).safeTransfer(msg.sender, refund);

        emit OrderCancelled(orderId, msg.sender, refund);
    }

    // ---------------------------------------------------------------------
    // Taker side
    // ---------------------------------------------------------------------

    /// @notice Fills an order, buying `sellFill` of the maker's offered token.
    /// @dev The taker must have approved this contract for at least the returned
    ///      `buyFill` amount of the order's buy token.
    /// @param orderId Order to fill.
    /// @param sellFill Amount of the maker's sell token the taker wants to receive.
    /// @return buyFill Amount of the buy token the taker pays (fee included).
    /// @return fee Protocol fee portion of `buyFill`.
    function fill(uint256 orderId, uint256 sellFill)
        external
        nonReentrant
        returns (uint256 buyFill, uint256 fee)
    {
        Order storage order = _orders[orderId];
        if (order.maker == address(0)) revert UnknownOrder();
        if (order.cancelled) revert OrderCancelledError();
        if (order.expiry != 0 && block.timestamp > order.expiry) revert OrderExpired();
        if (msg.sender == order.maker) revert SelfFill();

        uint256 remainingSell = order.sellAmount - order.filledSell;
        if (sellFill == 0 || sellFill > remainingSell) revert InvalidFillAmount();

        if (sellFill == remainingSell) {
            // Final fill: sweep the exact remainder so rounding can never leave dust behind.
            buyFill = order.buyAmount - order.filledBuy;
        } else {
            // Partial fill: pro-rata against the maker's original ratio, rounded down.
            buyFill = (sellFill * order.buyAmount) / order.sellAmount;
            if (buyFill == 0) revert FillTooSmall();
            if (buyFill > order.buyAmount - order.filledBuy) revert InvalidFillAmount();
        }

        order.filledSell += sellFill;
        order.filledBuy += buyFill;

        fee = (buyFill * feeBps) / BPS_DENOMINATOR;
        if (fee != 0) {
            accruedFees[order.buyToken] += fee;
        }

        // Taker -> maker (net of fee) and taker -> contract (fee reserve).
        IERC20(order.buyToken).safeTransferFrom(msg.sender, order.maker, buyFill - fee);
        if (fee != 0) {
            IERC20(order.buyToken).safeTransferFrom(msg.sender, address(this), fee);
        }

        // Contract -> taker (from escrow).
        IERC20(order.sellToken).safeTransfer(msg.sender, sellFill);

        emit OrderFilled(orderId, msg.sender, sellFill, buyFill, fee);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Updates the protocol fee. Capped by `MAX_FEE_BPS`.
    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeBpsUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    /// @notice Updates the fee recipient.
    function setFeeRecipient(address newFeeRecipient) external onlyOwner {
        if (newFeeRecipient == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, newFeeRecipient);
        feeRecipient = newFeeRecipient;
    }

    /// @notice Withdraws accrued fees for a token.
    /// @dev Callable by the owner or the fee recipient.
    function withdrawFees(address token, address to) external nonReentrant {
        if (msg.sender != owner() && msg.sender != feeRecipient) revert NotAuthorized();
        if (to == address(0)) revert ZeroAddress();

        uint256 amount = accruedFees[token];
        if (amount == 0) revert NothingToWithdraw();

        accruedFees[token] = 0;
        IERC20(token).safeTransfer(to, amount);

        emit FeesWithdrawn(token, to, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Returns the full order record.
    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    /// @notice Returns the unfilled amounts of an order.
    function remaining(uint256 orderId) external view returns (uint256 sellRemaining, uint256 buyRemaining) {
        Order storage order = _orders[orderId];
        sellRemaining = order.sellAmount - order.filledSell;
        buyRemaining = order.buyAmount - order.filledBuy;
    }

    /// @notice Returns the price of an order as buy token per 1e18 units of sell token.
    function pricePerSellToken(uint256 orderId) external view returns (uint256) {
        Order storage order = _orders[orderId];
        if (order.sellAmount == 0) return 0;
        return (order.buyAmount * 1e18) / order.sellAmount;
    }

    /// @notice Returns every order id created by a maker, including filled and cancelled ones.
    function getMakerOrderIds(address maker) external view returns (uint256[] memory) {
        return _makerOrderIds[maker];
    }
}
