const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const SELL_AMOUNT = ethers.parseEther("100"); // maker offers 100 SELL
const BUY_AMOUNT = ethers.parseEther("250"); // maker asks for 250 BUY (price = 2.5)
const FEE_BPS = 30n; // 0.30%

const feeOn = (buyFill) => (buyFill * FEE_BPS) / 10_000n;

async function deployFixture() {
  const [owner, maker, taker, feeRecipient, stranger] = await ethers.getSigners();

  const tokenFactory = await ethers.getContractFactory("MockERC20");
  const sellToken = await tokenFactory.deploy("Sell Token", "SELL");
  const buyToken = await tokenFactory.deploy("Buy Token", "BUY");

  const settlementFactory = await ethers.getContractFactory("OnchainSettlement");
  const settlement = await settlementFactory.deploy(
    owner.address,
    FEE_BPS,
    feeRecipient.address
  );

  await sellToken.mint(maker.address, ethers.parseEther("1000"));
  await buyToken.mint(taker.address, ethers.parseEther("1000"));

  await sellToken.connect(maker).approve(settlement.target, ethers.MaxUint256);
  await buyToken.connect(taker).approve(settlement.target, ethers.MaxUint256);

  const expiry = BigInt(await time.latest()) + 3600n;

  return { owner, maker, taker, feeRecipient, stranger, sellToken, buyToken, settlement, expiry };
}

async function createDefaultOrder(ctx) {
  await ctx.settlement
    .connect(ctx.maker)
    .createOrder(ctx.sellToken.target, ctx.buyToken.target, SELL_AMOUNT, BUY_AMOUNT, ctx.expiry);
  return 1n;
}

describe("OnchainSettlement", function () {
  describe("createOrder", function () {
    it("escrows the sell token and stores the order", async function () {
      const ctx = await deployFixture();

      await expect(
        ctx.settlement
          .connect(ctx.maker)
          .createOrder(ctx.sellToken.target, ctx.buyToken.target, SELL_AMOUNT, BUY_AMOUNT, ctx.expiry)
      )
        .to.emit(ctx.settlement, "OrderCreated")
        .withArgs(1n, ctx.maker.address, ctx.sellToken.target, ctx.buyToken.target, SELL_AMOUNT, BUY_AMOUNT, ctx.expiry);

      expect(await ctx.sellToken.balanceOf(ctx.maker.address)).to.equal(
        ethers.parseEther("900")
      );
      expect(await ctx.sellToken.balanceOf(ctx.settlement.target)).to.equal(SELL_AMOUNT);

      const order = await ctx.settlement.getOrder(1n);
      expect(order.maker).to.equal(ctx.maker.address);
      expect(order.sellAmount).to.equal(SELL_AMOUNT);
      expect(order.buyAmount).to.equal(BUY_AMOUNT);
      expect(order.filledSell).to.equal(0n);
      expect(order.filledBuy).to.equal(0n);
      expect(order.cancelled).to.equal(false);

      expect(await ctx.settlement.getMakerOrderIds(ctx.maker.address)).to.deep.equal([1n]);
    });

    it("rejects identical tokens", async function () {
      const ctx = await deployFixture();
      await expect(
        ctx.settlement
          .connect(ctx.maker)
          .createOrder(ctx.sellToken.target, ctx.sellToken.target, SELL_AMOUNT, BUY_AMOUNT, ctx.expiry)
      ).to.be.revertedWithCustomError(ctx.settlement, "IdenticalTokens");
    });

    it("rejects zero amounts", async function () {
      const ctx = await deployFixture();
      await expect(
        ctx.settlement
          .connect(ctx.maker)
          .createOrder(ctx.sellToken.target, ctx.buyToken.target, 0, BUY_AMOUNT, ctx.expiry)
      ).to.be.revertedWithCustomError(ctx.settlement, "ZeroAmount");
    });

    it("rejects an expiry in the past", async function () {
      const ctx = await deployFixture();
      const past = BigInt(await time.latest()) - 1n;
      await expect(
        ctx.settlement
          .connect(ctx.maker)
          .createOrder(ctx.sellToken.target, ctx.buyToken.target, SELL_AMOUNT, BUY_AMOUNT, past)
      ).to.be.revertedWithCustomError(ctx.settlement, "ExpiryInPast");
    });

    it("rejects orders without token approval", async function () {
      const ctx = await deployFixture();
      await expect(
        ctx.settlement
          .connect(ctx.stranger)
          .createOrder(ctx.sellToken.target, ctx.buyToken.target, SELL_AMOUNT, BUY_AMOUNT, ctx.expiry)
      ).to.be.reverted;
    });
  });

  describe("fill", function () {
    it("settles a full fill at the maker's price and takes the fee from the taker", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);

      const fee = feeOn(BUY_AMOUNT);

      await expect(ctx.settlement.connect(ctx.taker).fill(1n, SELL_AMOUNT))
        .to.emit(ctx.settlement, "OrderFilled")
        .withArgs(1n, ctx.taker.address, SELL_AMOUNT, BUY_AMOUNT, fee);

      // Taker paid the full buy amount and received the escrowed sell token.
      expect(await ctx.buyToken.balanceOf(ctx.taker.address)).to.equal(
        ethers.parseEther("750")
      );
      expect(await ctx.sellToken.balanceOf(ctx.taker.address)).to.equal(SELL_AMOUNT);
      expect(await ctx.sellToken.balanceOf(ctx.settlement.target)).to.equal(0n);

      // Maker receives the buy amount net of fee.
      expect(await ctx.buyToken.balanceOf(ctx.maker.address)).to.equal(BUY_AMOUNT - fee);

      // Fee is accrued for the recipient, not paid out eagerly.
      expect(await ctx.settlement.accruedFees(ctx.buyToken.target)).to.equal(fee);

      // Conservation: maker payout + accrued fee == what the taker paid.
      expect(await ctx.buyToken.balanceOf(ctx.maker.address) + (await ctx.settlement.accruedFees(ctx.buyToken.target))).to.equal(
        BUY_AMOUNT
      );

      const [sellRemaining, buyRemaining] = await ctx.settlement.remaining(1n);
      expect(sellRemaining).to.equal(0n);
      expect(buyRemaining).to.equal(0n);
    });

    it("supports partial fills pro-rata to the maker's ratio", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);

      const sellFill = ethers.parseEther("40");
      const expectedBuyFill = (sellFill * BUY_AMOUNT) / SELL_AMOUNT; // 100 BUY
      const fee = feeOn(expectedBuyFill);

      await expect(ctx.settlement.connect(ctx.taker).fill(1n, sellFill))
        .to.emit(ctx.settlement, "OrderFilled")
        .withArgs(1n, ctx.taker.address, sellFill, expectedBuyFill, fee);

      expect(await ctx.sellToken.balanceOf(ctx.taker.address)).to.equal(sellFill);
      expect(await ctx.buyToken.balanceOf(ctx.maker.address)).to.equal(expectedBuyFill - fee);

      const order = await ctx.settlement.getOrder(1n);
      expect(order.filledSell).to.equal(sellFill);
      expect(order.filledBuy).to.equal(expectedBuyFill);

      const [sellRemaining, buyRemaining] = await ctx.settlement.remaining(1n);
      expect(sellRemaining).to.equal(SELL_AMOUNT - sellFill);
      expect(buyRemaining).to.equal(BUY_AMOUNT - expectedBuyFill);
    });

    it("leaves no dust after a sequence of partial fills", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);

      const slices = [
        ethers.parseEther("40"),
        ethers.parseEther("30"),
        ethers.parseEther("30"), // final slice sweeps the exact remainder
      ];

      for (const slice of slices) {
        await ctx.settlement.connect(ctx.taker).fill(1n, slice);
      }

      // Taker paid exactly the requested buy amount, no rounding residue.
      expect(await ctx.buyToken.balanceOf(ctx.taker.address)).to.equal(
        ethers.parseEther("750")
      );
      expect(await ctx.sellToken.balanceOf(ctx.taker.address)).to.equal(SELL_AMOUNT);

      const [sellRemaining, buyRemaining] = await ctx.settlement.remaining(1n);
      expect(sellRemaining).to.equal(0n);
      expect(buyRemaining).to.equal(0n);
    });

    it("reverts when the fill is too small to be priced", async function () {
      const ctx = await deployFixture();
      // 1000 SELL for 1 BUY: a 1 wei fill rounds to zero buy tokens.
      await ctx.settlement
        .connect(ctx.maker)
        .createOrder(ctx.sellToken.target, ctx.buyToken.target, ethers.parseEther("1000"), 1n, ctx.expiry);

      await expect(ctx.settlement.connect(ctx.taker).fill(1n, 1n)).to.be.revertedWithCustomError(
        ctx.settlement,
        "FillTooSmall"
      );
    });

    it("rejects zero and oversized fills", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);

      await expect(ctx.settlement.connect(ctx.taker).fill(1n, 0)).to.be.revertedWithCustomError(
        ctx.settlement,
        "InvalidFillAmount"
      );
      await expect(
        ctx.settlement.connect(ctx.taker).fill(1n, SELL_AMOUNT + 1n)
      ).to.be.revertedWithCustomError(ctx.settlement, "InvalidFillAmount");
    });

    it("rejects an unknown order", async function () {
      const ctx = await deployFixture();
      await expect(ctx.settlement.connect(ctx.taker).fill(42n, 1n)).to.be.revertedWithCustomError(
        ctx.settlement,
        "UnknownOrder"
      );
    });

    it("rejects self fills", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);

      await expect(
        ctx.settlement.connect(ctx.maker).fill(1n, SELL_AMOUNT)
      ).to.be.revertedWithCustomError(ctx.settlement, "SelfFill");
    });

    it("rejects fills after expiry", async function () {
      const ctx = await deployFixture();
      const shortExpiry = BigInt(await time.latest()) + 100n;
      await ctx.settlement
        .connect(ctx.maker)
        .createOrder(ctx.sellToken.target, ctx.buyToken.target, SELL_AMOUNT, BUY_AMOUNT, shortExpiry);

      await time.increase(200);

      await expect(
        ctx.settlement.connect(ctx.taker).fill(1n, SELL_AMOUNT)
      ).to.be.revertedWithCustomError(ctx.settlement, "OrderExpired");
    });

    it("rejects fills without buy-token approval", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);

      await ctx.buyToken.connect(ctx.taker).approve(ctx.settlement.target, 0);

      await expect(ctx.settlement.connect(ctx.taker).fill(1n, SELL_AMOUNT)).to.be.reverted;
    });

    it("is safe against re-entrancy from the buy token", async function () {
      const [owner, maker, taker, feeRecipient] = await ethers.getSigners();

      const tokenFactory = await ethers.getContractFactory("MockERC20");
      const sellToken = await tokenFactory.deploy("Sell Token", "SELL");

      const reentrantFactory = await ethers.getContractFactory("ReentrantERC20");
      const buyToken = await reentrantFactory.deploy("Reentrant Token", "REENT");

      const settlementFactory = await ethers.getContractFactory("OnchainSettlement");
      const settlement = await settlementFactory.deploy(owner.address, 0n, feeRecipient.address);

      await sellToken.mint(maker.address, SELL_AMOUNT);
      await buyToken.mint(taker.address, BUY_AMOUNT);

      await sellToken.connect(maker).approve(settlement.target, ethers.MaxUint256);
      await buyToken.connect(taker).approve(settlement.target, ethers.MaxUint256);

      const expiry = BigInt(await time.latest()) + 3600n;
      await settlement
        .connect(maker)
        .createOrder(sellToken.target, buyToken.target, SELL_AMOUNT, BUY_AMOUNT, expiry);

      // Arm the token so the next transferFrom re-enters fill().
      await buyToken.arm(settlement.target, 1n, ethers.parseEther("10"));

      await expect(settlement.connect(taker).fill(1n, ethers.parseEther("10")))
        .to.be.revertedWithCustomError(settlement, "ReentrancyGuardReentrantCall");
    });
  });

  describe("cancelOrder", function () {
    it("refunds the unfilled escrow", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);
      await ctx.settlement.connect(ctx.taker).fill(1n, ethers.parseEther("40"));

      const refund = SELL_AMOUNT - ethers.parseEther("40");

      await expect(ctx.settlement.connect(ctx.maker).cancelOrder(1n))
        .to.emit(ctx.settlement, "OrderCancelled")
        .withArgs(1n, ctx.maker.address, refund);

      expect(await ctx.sellToken.balanceOf(ctx.maker.address)).to.equal(
        ethers.parseEther("1000") - ethers.parseEther("40")
      );
      expect(await ctx.sellToken.balanceOf(ctx.settlement.target)).to.equal(0n);

      const order = await ctx.settlement.getOrder(1n);
      expect(order.cancelled).to.equal(true);
    });

    it("blocks fills on a cancelled order", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);
      await ctx.settlement.connect(ctx.maker).cancelOrder(1n);

      await expect(
        ctx.settlement.connect(ctx.taker).fill(1n, SELL_AMOUNT)
      ).to.be.revertedWithCustomError(ctx.settlement, "OrderCancelledError");
    });

    it("rejects a cancel from anyone but the maker", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);

      await expect(
        ctx.settlement.connect(ctx.stranger).cancelOrder(1n)
      ).to.be.revertedWithCustomError(ctx.settlement, "NotMaker");
    });

    it("rejects cancelling twice", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);
      await ctx.settlement.connect(ctx.maker).cancelOrder(1n);

      await expect(
        ctx.settlement.connect(ctx.maker).cancelOrder(1n)
      ).to.be.revertedWithCustomError(ctx.settlement, "OrderCancelledError");
    });

    it("rejects cancelling a fully filled order", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);
      await ctx.settlement.connect(ctx.taker).fill(1n, SELL_AMOUNT);

      await expect(
        ctx.settlement.connect(ctx.maker).cancelOrder(1n)
      ).to.be.revertedWithCustomError(ctx.settlement, "OrderFullyFilled");
    });

    it("rejects an unknown order", async function () {
      const ctx = await deployFixture();
      await expect(
        ctx.settlement.connect(ctx.maker).cancelOrder(99n)
      ).to.be.revertedWithCustomError(ctx.settlement, "UnknownOrder");
    });
  });

  describe("fees", function () {
    it("collects fees over multiple fills and lets the recipient withdraw", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);

      await ctx.settlement.connect(ctx.taker).fill(1n, ethers.parseEther("40"));
      await ctx.settlement.connect(ctx.taker).fill(1n, ethers.parseEther("60"));

      const accrued = await ctx.settlement.accruedFees(ctx.buyToken.target);
      expect(accrued).to.equal(feeOn(BUY_AMOUNT));

      await expect(
        ctx.settlement.connect(ctx.feeRecipient).withdrawFees(ctx.buyToken.target, ctx.feeRecipient.address)
      )
        .to.emit(ctx.settlement, "FeesWithdrawn")
        .withArgs(ctx.buyToken.target, ctx.feeRecipient.address, accrued);

      expect(await ctx.buyToken.balanceOf(ctx.feeRecipient.address)).to.equal(accrued);
      expect(await ctx.settlement.accruedFees(ctx.buyToken.target)).to.equal(0n);
    });

    it("charges nothing when the fee is zero", async function () {
      const ctx = await deployFixture();
      await ctx.settlement.connect(ctx.owner).setFeeBps(0);
      await createDefaultOrder(ctx);

      await ctx.settlement.connect(ctx.taker).fill(1n, SELL_AMOUNT);

      expect(await ctx.buyToken.balanceOf(ctx.maker.address)).to.equal(BUY_AMOUNT);
      expect(await ctx.settlement.accruedFees(ctx.buyToken.target)).to.equal(0n);
    });

    it("restricts withdrawFees to the owner or the fee recipient", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);
      await ctx.settlement.connect(ctx.taker).fill(1n, SELL_AMOUNT);

      await expect(
        ctx.settlement.connect(ctx.stranger).withdrawFees(ctx.buyToken.target, ctx.stranger.address)
      ).to.be.revertedWithCustomError(ctx.settlement, "NotAuthorized");

      await expect(
        ctx.settlement.connect(ctx.owner).withdrawFees(ctx.buyToken.target, ctx.owner.address)
      ).to.not.be.reverted;
    });

    it("reverts when there is nothing to withdraw", async function () {
      const ctx = await deployFixture();
      await expect(
        ctx.settlement.connect(ctx.feeRecipient).withdrawFees(ctx.buyToken.target, ctx.feeRecipient.address)
      ).to.be.revertedWithCustomError(ctx.settlement, "NothingToWithdraw");
    });

    it("caps the fee", async function () {
      const ctx = await deployFixture();

      await expect(ctx.settlement.connect(ctx.owner).setFeeBps(101n))
        .to.be.revertedWithCustomError(ctx.settlement, "FeeTooHigh");

      await expect(ctx.settlement.connect(ctx.owner).setFeeBps(100n))
        .to.emit(ctx.settlement, "FeeBpsUpdated")
        .withArgs(FEE_BPS, 100n);
    });

    it("restricts fee configuration to the owner", async function () {
      const ctx = await deployFixture();

      await expect(
        ctx.settlement.connect(ctx.stranger).setFeeBps(0)
      ).to.be.revertedWithCustomError(ctx.settlement, "OwnableUnauthorizedAccount");

      await expect(
        ctx.settlement.connect(ctx.stranger).setFeeRecipient(ctx.stranger.address)
      ).to.be.revertedWithCustomError(ctx.settlement, "OwnableUnauthorizedAccount");
    });

    it("rejects a zero fee recipient", async function () {
      const ctx = await deployFixture();
      await expect(
        ctx.settlement.connect(ctx.owner).setFeeRecipient(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(ctx.settlement, "ZeroAddress");
    });
  });

  describe("views", function () {
    it("reports the price per sell token", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);

      // 250 BUY per 100 SELL, scaled by 1e18.
      expect(await ctx.settlement.pricePerSellToken(1n)).to.equal(ethers.parseEther("2.5"));
    });

    it("tracks every order a maker has created", async function () {
      const ctx = await deployFixture();
      await createDefaultOrder(ctx);
      await ctx.settlement
        .connect(ctx.maker)
        .createOrder(ctx.sellToken.target, ctx.buyToken.target, ethers.parseEther("10"), ethers.parseEther("20"), ctx.expiry);

      expect(await ctx.settlement.getMakerOrderIds(ctx.maker.address)).to.deep.equal([1n, 2n]);
    });
  });
});
